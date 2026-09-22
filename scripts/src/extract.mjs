#!/usr/bin/env node
// 月明·抖音萃取 · 主入口 CLI
//
// 命令行：
//   node src/extract.mjs --account <id> [--login-only | --auth-probe]
//   node src/extract.mjs --account <id> [--no-comments | --comments-only] [--aweme <id>] [--force] [--resume] [--auth-dir <abs>] [--max-pages <n>]
//
// 默认：
//   --account  _default
//   --auth-dir ~/.moonlit-creator/.auth/douyin/<account>
//   --root     ~/moonlit-creator/works/douyin
//
// 流程：
//   1. 解析 CLI
//   2. ensureProfileNotLocked (SingletonLock 冲突检测)
//   3. (--login-only) 调 loginDouyinProfile 弹 headed 扫码，关窗退出
//   4. mkdir authDir（自动建）+ mkdir root（自动建）
//   5. (--auth-probe) 起 headless 探针 → 输出三态之一 → 退出
//   6. openProfile + probeSession
//      - 'unknown' 或 'expired' → 抛 DouyinNotLoggedInError，提示先 --login-only
//   7. fetchAllWorksMetrics（除非 --comments-only / --auth-probe / --login-only）
//   8. fetchCommentsForWorks（除非 --no-comments / --login-only / --auth-probe）
//   9. writeIndex
//  10. close + summary

import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ensureProfileNotLocked,
  openProfile,
  probeSession,
  loginDouyinProfile,
  DouyinNotLoggedInError,
  DouyinProfileLockedError,
} from './browser.mjs';
import { fetchAllWorksMetrics } from './metrics.mjs';
import { fetchCommentsForWork, fetchCommentsForWorks } from './comments.mjs';
import {
  writeIndex,
  writeMeta,
  listFailedWorks,
  readMeta,
  resolveWorkDir,
} from './layout.mjs';

// ------------------------------------------------------------------
// CLI 解析（极简，不用 commander）
// ------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account') out.account = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--auth-dir') out.authDir = argv[++i];
    else if (a === '--aweme') out.aweme = argv[++i];
    else if (a === '--max-pages') out.maxPages = Number.parseInt(argv[++i], 10);
    else if (a === '--no-comments') out.noComments = true;
    else if (a === '--comments-only') out.commentsOnly = true;
    else if (a === '--force') out.force = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--auth-probe') out.authProbe = true;
    else if (a === '--login-only') out.loginOnly = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`月明·抖音萃取 - 抓取自己抖音账号的作品指标和评论，按作品切分落盘

用法:
  node src/extract.mjs --account ID [选项]

首次使用（任选其一）:
  node src/extract.mjs --account ID --login-only    # 只扫码登录，cookie 落 ~/.moonlit-creator/.auth/douyin/ID
  node src/extract.mjs --account ID --auth-probe    # 探针登录态（cron 健康检查）

后续采集:
  node src/extract.mjs --account ID                 # 全量（指标 + 评论）
  node src/extract.mjs --account ID --no-comments   # 只刷指标
  node src/extract.mjs --account ID --comments-only # 只刷评论
  node src/extract.mjs --account ID --aweme ID --force  # 单作品重采

会话过期怎么办:
  1. node src/extract.mjs --account ID --login-only   # 重扫
  2. node src/extract.mjs --account ID --resume       # 续跑失败的

选项:
  --account ID           账号 ID（默认 _default）
  --auth-dir <abs>       自定义登录态路径（默认 ~/.moonlit-creator/.auth/douyin/<account>）
  --root <path>          输出根目录（默认 ~/moonlit-creator/works/douyin）
  --aweme ID             只处理一个作品
  --max-pages <n>        每个作品最多翻几页（默认 40）
  --no-comments          只抓指标
  --comments-only        只抓评论
  --force                覆盖已有 metrics.json / comments.json
  --resume               只处理 _FAILED.json 标记的作品
  --login-only           弹窗扫码登录；不抓取（首次或重扫）
  --auth-probe           只探针登录态，立即退出（cron 健康检查）

详情见 SKILL.md 与 references/*.md。
`);
}

// ------------------------------------------------------------------
// 路径默认
// ------------------------------------------------------------------

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return resolve(join(homedir(), p.slice(1)));
  return resolve(p);
}

/**
 * Skill 自管理的登录态目录（Self-contained，不依赖 CreatorOS）。
 * 默认落在 ~/.moonlit-creator/ 下，与 works/ 同级。
 */
function defaultAuthDir(accountId) {
  return expandHome(`~/.moonlit-creator/.auth/douyin/${accountId}`);
}

function defaultRoot() {
  return expandHome('~/moonlit-creator/works/douyin');
}

// ------------------------------------------------------------------
// 收集已有作品 ID（comments-only / resume 用）
// ------------------------------------------------------------------

async function collectExistingAwemeIds(root) {
  const index = await readMetaIndex(root);
  if (index?.works) return index.works.map((w) => w.awemeId).filter(Boolean);
  const ids = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const meta = await readMeta(root, ent.name);
    if (meta?.awemeId) ids.push(meta.awemeId);
  }
  return ids;
}

async function readMetaIndex(root) {
  try {
    const text = await (await import('node:fs/promises')).readFile(join(root, '_index.json'), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const accountId = args.account ?? '_default';
  const root = args.root ? expandHome(args.root) : defaultRoot();
  const authDir = args.authDir ? expandHome(args.authDir) : defaultAuthDir(accountId);

  console.log(`[extract] 账号: ${accountId}`);
  console.log(`[extract] 登录态: ${authDir}`);
  console.log(`[extract] 输出根: ${root}`);

  // 0) --login-only：弹 headed 扫码登录，不抓取
  if (args.loginOnly) {
    await mkdir(authDir, { recursive: true });
    // 检查 SingletonLock（被占用则拒绝）
    try {
      ensureProfileNotLocked(authDir, accountId);
    } catch (err) {
      if (err instanceof DouyinProfileLockedError) {
        console.error(`✗ ${err.message}`);
        process.exit(3);
      }
      throw err;
    }
    console.log('[login] 弹出有头浏览器，请在 240 秒内扫码登录创作者中心…');
    const ok = await loginDouyinProfile({ authDir, timeoutSec: 240 });
    if (ok) {
      console.log(`[login] 登录成功 → ${authDir}`);
      process.exit(0);
    } else {
      console.error('✗ 登录超时或窗口被关闭；请重跑 --login-only 重试');
      process.exit(5);
    }
  }

  await mkdir(root, { recursive: true });

  // 1) SingletonLock 冲突检测
  try {
    ensureProfileNotLocked(authDir, accountId);
  } catch (err) {
    if (err instanceof DouyinProfileLockedError) {
      console.error(`✗ ${err.message}`);
      process.exit(3);
    }
    throw err;
  }

  // 2) 登录态目录必须存在 → 否则引导先扫码
  if (!existsSync(authDir)) {
    console.error(`✗ 登录态目录不存在: ${authDir}`);
    console.error('');
    console.error('首次使用请先扫码一次：');
    console.error(`  node scripts/src/extract.mjs --account ${accountId} --login-only`);
    console.error('');
    console.error('会弹出有头 Chromium 窗口，请扫码抖音创作者中心二维码。');
    console.error('cookie 会落到上述登录态目录，下次再跑就不需要扫码了。');
    process.exit(2);
  }

  // 3) 启动 Chromium
  const ctx = await openProfile({ authDir, headless: true });
  let exitCode = 0;
  try {
    // 4) 登录态探针
    const status = await probeSession(ctx);
    console.log(`[extract] 登录态: ${status}`);
    if (status !== 'active') {
      throw new DouyinNotLoggedInError(
        status === 'expired'
          ? '会话已过期（status_code=8）。请重跑 --login-only 重扫一次。'
          : '未检测到有效 sessionid cookie。请先跑 --login-only 扫码登录。',
      );
    }

    // 仅探针
    if (args.authProbe) {
      console.log('[extract] 登录态探针 OK');
      process.exit(0);
    }

    const capturedAt = new Date().toISOString();
    const force = !!args.force;
    const maxPages = args.maxPages ?? undefined;

    // 决定目标作品集
    let targetWorks = []; // [{awemeId, title, publishedAt, shareUrl, metrics?}]
    if (args.aweme) {
      // 单作品路径：metrics + comments 一并
      console.log(`[extract] 单作品模式: ${args.aweme}`);
      const { works } = await fetchAllWorksMetrics({
        ctx,
        capturedAt,
        root,
        force,
        maxPages,
      });
      targetWorks = works.filter((w) => w.awemeId === args.aweme);
      if (targetWorks.length === 0) {
        console.warn(`[extract] 作品列表中未找到 ${args.aweme}（可能不在最近 40 页内）`);
        // 仍尝试写 meta（用已知 awemeId）+ 走评论（不依赖 work_list）
      }
      if (targetWorks.length === 0) {
        await writeMeta(await resolveWorkDir(root, args.aweme), {
          awemeId: args.aweme,
          title: '',
          desc: '',
          durationSec: 0,
          publishedAt: null,
          shareUrl: `https://www.douyin.com/video/${args.aweme}`,
          capturedAt,
        });
        targetWorks = [{
          awemeId: args.aweme,
          title: '',
          publishedAt: null,
          shareUrl: `https://www.douyin.com/video/${args.aweme}`,
          metrics: null,
        }];
      }
      if (!args.noComments) {
        const { results } = await fetchCommentsForWorks({
          ctx,
          awemeIds: [args.aweme],
          capturedAt,
          root,
          force,
        });
        const r = results[0];
        if (r) {
          targetWorks[0].commentsCount = r.records.length;
          targetWorks[0].commentsIncomplete = r.incomplete;
        }
      }
    } else {
      // 全量 / metrics-only / comments-only
      let awemeIds = [];
      if (!args.commentsOnly) {
        const { works, pagesScanned, truncatedByHasMore } = await fetchAllWorksMetrics({
          ctx,
          capturedAt,
          root,
          force,
          maxPages,
        });
        targetWorks = works;
        awemeIds = works.map((w) => w.awemeId);
        console.log(
          `[extract] 指标抓取完成: ${works.length} 个作品 (扫了 ${pagesScanned} 页, hasMore-truncated=${truncatedByHasMore})`,
        );
      } else {
        awemeIds = await collectExistingAwemeIds(root);
        console.log(`[extract] comments-only: 现有 ${awemeIds.length} 个作品`);
      }

      // 处理 resume：只重跑 _FAILED.json 的作品
      if (args.resume) {
        const failedIds = await listFailedWorks(root);
        if (failedIds.length === 0) {
          console.log('[extract] resume: 没有失败作品，跳过');
        } else {
          console.log(`[extract] resume: 重试 ${failedIds.length} 个失败作品`);
          if (!args.commentsOnly) {
            const { works: reworks } = await fetchAllWorksMetrics({
              ctx,
              capturedAt,
              root,
              force: true,
              maxPages,
            });
            targetWorks = reworks;
            awemeIds = reworks.map((w) => w.awemeId);
          } else {
            awemeIds = awemeIds.filter((id) => failedIds.includes(id));
          }
        }
      }

      if (!args.noComments && awemeIds.length > 0) {
        const { results, truncated, truncatedReason } = await fetchCommentsForWorks({
          ctx,
          awemeIds,
          capturedAt,
          root,
          force,
        });
        const totalComments = results.reduce(
          (s, r) => s + r.records.length,
          0,
        );
        console.log(
          `[extract] 评论抓取完成: ${results.length}/${awemeIds.length} 个作品, ${totalComments} 条评论 (truncated=${truncated})`,
        );
        if (truncated && truncatedReason) {
          console.warn(`[extract] 截断原因: ${truncatedReason}`);
        }
        const commentsByAweme = new Map(
          results.map((r) => [r.awemeId, r]),
        );
        for (const w of targetWorks) {
          const c = commentsByAweme.get(w.awemeId);
          if (c) {
            w.commentsCount = c.records.length;
            w.commentsIncomplete = c.incomplete;
          }
        }
      }
    }

    // 写 _index.json
    await writeIndex(root, {
      accountId,
      totals: {
        works: targetWorks.length,
        comments: targetWorks.reduce(
          (s, w) => s + (w.commentsCount ?? 0),
          0,
        ),
      },
      works: targetWorks,
    });

    console.log('[done] 已完成');
    const summary = {
      accountId,
      root,
      metricsWritten: targetWorks.length,
      commentsWritten: targetWorks.reduce(
        (s, w) => s + (w.commentsCount ?? 0),
        0,
      ),
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    exitCode = 1;
    if (err instanceof DouyinNotLoggedInError) {
      console.error(`✗ ${err.message}`);
      exitCode = 4;
    } else if (err instanceof DouyinProfileLockedError) {
      console.error(`✗ ${err.message}`);
      exitCode = 3;
    } else {
      console.error(`✗ 异常退出: ${err?.stack ?? err}`);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`fatal: ${err?.stack ?? err}`);
  process.exit(99);
});
