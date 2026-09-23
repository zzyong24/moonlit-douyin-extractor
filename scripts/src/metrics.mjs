// 月明·抖音萃取 · 作品指标抓取
//
// 单次执行流程：
//   - 导航创作者中心 content/manage
//   - 拦截 work_list XHR（/aweme/v1/creator/item/list 等）
//   - 礼貌滚动翻页，每翻一页 sleep 4s（个人账号安全间隔）
//   - 解析 aweme_list / item_list → 元数据 + 指标
//   - 写 meta.json + metrics.json 到每个作品目录
//   - 末尾返回所有作品（供主入口更新 _index.json）
//
// 不做：
//   - 限流网关（个人账号简化）
//   - 可见性判定（个人账号作品都公开）
//   - ID 校验（个人账号所有作品都可信）
//   - 跨 run 增量（每次全量拿一遍，由 layout.mjs 的 history[] 兜历史）

import { join } from 'node:path';
import {
  parseWorkList,
  readHasMore,
  deriveTitle,
  toIsoFromUnixSeconds,
} from './parsers.mjs';
import {
  writeMeta,
  writeMetrics,
  writeFailure,
  clearFailure,
  writeRun,
  resolveWorkDir,
} from './layout.mjs';

const CREATOR_CONTENT = 'https://creator.douyin.com/creator-micro/content/manage';

// work_list XHR 端点候选（实测可命中其一）
const WORK_LIST_HINTS = [
  '/aweme/v1/creator/item/list',
  '/creator/pc/work_list',
  '/web/aweme/post',
];

const PAGE_SLEEP_MS = 4000; // 每翻一页间隔（个人账号安全值）
const DEFAULT_MAX_PAGES = 40;
const NAV_TIMEOUT_MS = 60_000;

/**
 * 简单退避重试（创作者中心偶发 60s 超时；3 次退避后还失败就抛原错）
 */
async function gotoWithRetry(page, url, signal) {
  const delays = [0, 2000, 5000, 10000];
  let lastErr = null;
  for (const delay of delays) {
    if (signal?.aborted) throw new Error('aborted');
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      return;
    } catch (err) {
      lastErr = err;
      const msg = err?.message ?? String(err);
      // 超时 / 关闭错误 → 重试；其它抛原错
      if (!/Timeout|timed? out|超时/i.test(msg)) throw err;
    }
  }
  throw lastErr;
}

/**
 * 抓取所有可见作品的指标 + 元数据
 *
 * @param {{
 *   ctx: import('playwright').BrowserContext,
 *   signal?: AbortSignal,
 *   capturedAt: string,
 *   root: string,
 *   accountId: string,
 *   force?: boolean,
 *   maxPages?: number
 * }} args
 * @returns {Promise<{
 *   works: Array<{awemeId, title, publishedAt, shareUrl, metrics}>,
 *   pagesScanned: number,
 *   truncatedByHasMore: boolean
 * }>}
 */
export async function fetchAllWorksMetrics({
  ctx,
  signal,
  capturedAt,
  root,
  accountId,
  force = false,
  maxPages = DEFAULT_MAX_PAGES,
}) {
  signal?.throwIfAborted?.();
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const workJsons = [];
  let hasMore = true;
  let pagesScanned = 0;
  let truncatedByHasMore = false;

  // 拦截 work_list XHR
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!WORK_LIST_HINTS.some((h) => url.includes(h))) return;
    const json = await resp.json().catch(() => null);
    if (!json) return;
    workJsons.push(json);
    const hm = readHasMore(json);
    if (typeof hm === 'boolean') {
      if (!hm) {
        hasMore = false;
        truncatedByHasMore = false;
      }
    }
  });

  // 导航
  await gotoWithRetry(page, CREATOR_CONTENT, signal);
  await page.waitForTimeout(3000); // 等首屏 XHR

  // 礼貌翻页
  for (let i = 0; i < maxPages; i++) {
    signal?.throwIfAborted?.();
    if (!hasMore) break;
    pagesScanned += 1;
    await page
      .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      .catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    await page.mouse.wheel(0, 3000).catch(() => {});
    await page.waitForTimeout(2500);
    // 限流间隔
    await new Promise((r) => setTimeout(r, PAGE_SLEEP_MS - 2500));
    // 若 hasMore 已被拦截器设为 false）则下一轮就退出
    if (!hasMore) break;
  }

  // 解析所有抓到的 XHR（去重 by aweme_id，取最后一次出现的）
  const works = [];
  const byId = new Map();
  for (const j of workJsons) {
    for (const w of parseWorkList(j)) {
      byId.set(w.awemeId, w);
    }
  }
  for (const w of byId.values()) works.push(w);

  // 落盘每个作品
  const summary = [];
  for (const w of works) {
    signal?.throwIfAborted?.();
    const publishedAt = toIsoFromUnixSeconds(w.createTime);
    const title = deriveTitle(w.title, w.desc);
    const shareUrl = `https://www.douyin.com/video/${w.awemeId}`;
    const workDir = await resolveWorkDir(root, w.awemeId, title, accountId);

    try {
      await writeMeta(workDir, {
        accountId,
        awemeId: w.awemeId,
        title,
        desc: w.desc ?? '',
        durationSec: w.durationSec ?? 0,
        publishedAt,
        shareUrl,
        capturedAt,
      });
      await writeMetrics(
        workDir,
        {
          awemeId: w.awemeId,
          capturedAt,
          metrics: {
            views: w.stats.views,
            likes: w.stats.likes,
            comments: w.stats.comments,
            shares: w.stats.shares,
            favorites: w.stats.favorites,
          },
          source: 'creator-center-work-list',
        },
        { force },
      );
      await clearFailure(workDir);
      summary.push({
        awemeId: w.awemeId,
        title,
        publishedAt,
        shareUrl,
        metrics: {
          views: w.stats.views,
          likes: w.stats.likes,
          comments: w.stats.comments,
          shares: w.stats.shares,
          favorites: w.stats.favorites,
        },
      });
    } catch (err) {
      console.error(
        `[metrics] 写 ${w.awemeId} 失败: ${err?.message ?? err}`,
      );
      await writeFailure(workDir, {
        awemeId: w.awemeId,
        stage: 'metrics',
        errorCode: err?.name ?? 'WriteError',
        errorMessage: err?.message ?? String(err),
      });
    }
  }

  await writeRun(join(root, '_run_metrics.json'), {
    startedAt: capturedAt,
    completedAt: new Date().toISOString(),
    pagesScanned,
    works: works.length,
    truncatedByHasMore,
  });

  return { works: summary, pagesScanned, truncatedByHasMore };
}
