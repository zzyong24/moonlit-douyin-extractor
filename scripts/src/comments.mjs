// 月明·抖音萃取 · 评论抓取
//
// 单作品路径：导航创作者中心评论管理页（带 item_id 过滤）→ 拦 /aweme/v1/web/comment/list/ XHR
//            → 翻页（限流 sleep 4s/页）→ 写 comments.json
// 批量路径：在单个 context 串行抓多个作品（open/close 只一次）
//
// 评论采集的边界处理：
//   - 评论管理页 URL：https://creator.douyin.com/creator-micro/interactive/comment?item_id=<id>
//     旧 URL content/comment-manage 已被抖音改向到 content/upload，不触发评论接口
//   - item_id 过滤偶发不生效：每条评论按 payload 自带 aweme_id 归属（旧实现误把整批归到目标作品）
//   - 列表是内层滚动容器：只滚 window 触不到，需要 evaluate 内层可滚元素

import { join } from 'node:path';
import { parseCommentList } from './parsers.mjs';
import { writeComments, writeFailure, clearFailure, writeRun, resolveWorkDir, readMeta } from './layout.mjs';

const CREATOR_COMMENT_MANAGE =
  'https://creator.douyin.com/creator-micro/interactive/comment';
const COMMENT_LIST_HINTS = ['/aweme/v1/web/comment/list/'];
const DEFAULT_MAX_PAGES = 40;
const PAGE_SLEEP_MS = 4000;
const NAV_TIMEOUT_MS = 60_000;

// 与 metrics.mjs 同款的退避重试
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
      if (!/Timeout|timed? out|超时/i.test(msg)) throw err;
    }
  }
  throw lastErr;
}

/**
 * 在指定 page 上抓一个作品的评论（不关 context）。
 * @returns {Promise<{records: Array, hitWatermark: boolean, staleRounds: number}>}
 */
async function scrapeCommentsForWork(page, awemeId, maxPages, signal) {
  const commentJsons = [];
  const seenIds = new Set();
  let staleRounds = 0;
  const onResponse = async (resp) => {
    const url = resp.url();
    if (!COMMENT_LIST_HINTS.some((h) => url.includes(h))) return;
    const json = await resp.json().catch(() => null);
    if (!json) return;
    commentJsons.push(json);
    for (const c of parseCommentList(json, awemeId)) {
      seenIds.add(c.commentId);
    }
  };
  page.on('response', onResponse);
  try {
    await gotoWithRetry(
      page,
      `${CREATOR_COMMENT_MANAGE}?item_id=${encodeURIComponent(awemeId)}`,
      signal,
    );
    await page.waitForTimeout(3000);

    for (let i = 0; i < maxPages; i++) {
      if (signal?.aborted) throw new Error('aborted');
      const before = seenIds.size;
      await page
        .evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (el && el.scrollHeight > el.clientHeight + 100) {
              el.scrollTop = el.scrollHeight;
            }
          }
        })
        .catch(() => {});
      await page.mouse.wheel(0, 2000).catch(() => {});
      await page.waitForTimeout(2000);
      // 限流间隔
      await new Promise((r) => setTimeout(r, PAGE_SLEEP_MS - 2000));
      staleRounds = seenIds.size === before ? staleRounds + 1 : 0;
      if (staleRounds >= 3) break;
    }

    // 去重
    const byId = new Map();
    for (const j of commentJsons) {
      for (const c of parseCommentList(j, awemeId)) byId.set(c.commentId, c);
    }
    return { records: [...byId.values()], hitWatermark: false, staleRounds };
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * 抓一个作品的评论（含打开新 context / 关闭）。
 * 用于 --aweme 单作品路径。
 */
export async function fetchCommentsForWork({
  ctx,
  awemeId,
  signal,
  root,
  accountId,
  capturedAt,
  force = false,
}) {
  const meta = await readMeta(root, awemeId);
  const workDir = await resolveWorkDir(root, awemeId, meta?.title ?? '', accountId);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let incomplete = false;
  let truncatedReason = null;
  let records = [];
  try {
    const out = await scrapeCommentsForWork(
      page,
      awemeId,
      DEFAULT_MAX_PAGES,
      signal,
    );
    records = out.records;
  } catch (err) {
    incomplete = true;
    truncatedReason = err?.message ?? String(err);
    await writeFailure(workDir, {
      awemeId,
      stage: 'comments',
      errorCode: err?.name ?? 'ScrapeError',
      errorMessage: truncatedReason,
    });
  }
  await writeComments(
    workDir,
    {
      awemeId,
      collectedAt: capturedAt,
      incomplete,
      truncatedReason,
      count: records.length,
      items: records,
    },
    { force },
  );
  if (!incomplete) await clearFailure(workDir);
  return { awemeId, records, incomplete, truncatedReason };
}

/**
 * 批量抓多个作品的评论（复用单 context）。
 * 撞冷却或登出立即停止。
 */
export async function fetchCommentsForWorks({
  ctx,
  awemeIds,
  signal,
  root,
  accountId,
  capturedAt,
  force = false,
}) {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const results = [];
  let truncated = false;
  let truncatedReason = null;

  for (const awemeId of awemeIds) {
    if (signal?.aborted) throw new Error('aborted');
    const meta = await readMeta(root, awemeId);
    const workDir = await resolveWorkDir(root, awemeId, meta?.title ?? '', accountId);
    let incomplete = false;
    let reason = null;
    let records = [];
    try {
      const out = await scrapeCommentsForWork(page, awemeId, DEFAULT_MAX_PAGES, signal);
      records = out.records;
    } catch (err) {
      // 登出 → 立即停剩余作品
      if (err?.name === 'DouyinNotLoggedInError') {
        truncated = true;
        truncatedReason = `账号会话过期,已采 ${results.length}/${awemeIds.length} 个作品`;
        break;
      }
      incomplete = true;
      reason = err?.message ?? String(err);
      await writeFailure(workDir, {
        awemeId,
        stage: 'comments',
        errorCode: err?.name ?? 'ScrapeError',
        errorMessage: reason,
      });
    }
    await writeComments(
      workDir,
      {
        awemeId,
        collectedAt: capturedAt,
        incomplete,
        truncatedReason: reason,
        count: records.length,
        items: records,
      },
      { force },
    );
    if (!incomplete) await clearFailure(workDir);
    results.push({ awemeId, records, incomplete, truncatedReason: reason });
  }

  await writeRun(join(root, '_run_comments.json'), {
    startedAt: capturedAt,
    completedAt: new Date().toISOString(),
    works: awemeIds.length,
    collected: results.length,
    truncated,
    truncatedReason,
  });

  return { results, truncated, truncatedReason };
}
