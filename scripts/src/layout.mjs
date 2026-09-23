// 月明·抖音萃取 · 落盘布局
//
// 单一职责：把内存里的 DouyinWork / CommentRecord 落盘到文件系统。
// 策略见 ../references/output-layout.md
//
// 关键约定：
//   - meta.json：始终覆盖（标题/发布时间可能微调）
//   - metrics.json：默认追加到 history[]，仅 --force 时重写
//   - comments.json：默认合并去重（按 commentId），仅 --force 时重写
//   - 失败时只写 _FAILED.json，不动已成功写的文件
//   - _index.json 每次 run 末尾重写

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { basename, join, dirname, relative, resolve } from 'node:path';
import { validateAccountId } from './accounts.mjs';

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function readJsonSafe(path, fallback = null) {
  try {
    const txt = await readFile(path, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// Keep the index/unassigned data under the per-account root. When the usual
// moonlit-creator work tree is present, put each account's data in its own
// distribution/douyin/<accountId>/ namespace. Match only by stable awemeId;
// titles are not unique identities.
export async function resolveWorkDir(root, awemeId, _title = '', accountId = '_default') {
  validateAccountId(accountId);
  const possibleWorksRoot = resolve(root, '../..');
  const worksRoot = basename(possibleWorksRoot) === 'works' ? possibleWorksRoot : dirname(root);
  let years = [];
  try { years = await readdir(worksRoot, { withFileTypes: true }); } catch {}
  for (const year of years) {
    if (!year.isDirectory() || !/^20\d{2}$/.test(year.name)) continue;
    let works = [];
    try { works = await readdir(join(worksRoot, year.name), { withFileTypes: true }); } catch {}
    for (const entry of works) {
      if (!entry.isDirectory()) continue;
      const workPath = join(worksRoot, year.name, entry.name);
      const work = await readJsonSafe(join(workPath, 'work.json'), null);
      const ids = work?.platformIds?.douyin ?? work?.distributionIds?.douyin ?? [];
      if (ids.includes(awemeId)) return join(workPath, 'distribution', 'douyin', accountId, awemeId);
    }
  }
  // 未建立作品映射的历史视频也不再散落成数字目录，集中等待人工归档。
  return join(root, '_unassigned', awemeId);
}

// ------------------------------------------------------------------
// meta.json
// ------------------------------------------------------------------

/**
 * @param {string} workDir
 * @param {{
 *   awemeId: string,
 *   title: string,
 *   desc: string,
 *   durationSec: number,
 *   publishedAt: string|null,
 *   shareUrl: string,
 *   capturedAt: string
 * }} meta
 */
export async function writeMeta(workDir, meta) {
  await ensureDir(workDir);
  await writeJson(join(workDir, 'meta.json'), meta);
}

// ------------------------------------------------------------------
// metrics.json（含 history[]）
// ------------------------------------------------------------------

/**
 * @param {string} workDir
 * @param {{
 *   awemeId: string,
 *   capturedAt: string,
 *   metrics: object,
 *   source?: string
 * }} snapshot
 * @param {{ force?: boolean }} [opts]
 */
export async function writeMetrics(workDir, snapshot, opts = {}) {
  await ensureDir(workDir);
  const path = join(workDir, 'metrics.json');
  const existing = await readJsonSafe(path, null);

  if (opts.force || !existing) {
    await writeJson(path, {
      awemeId: snapshot.awemeId,
      history: [snapshot],
      latest: snapshot,
    });
    return { merged: false, length: 1 };
  }

  // 追加到 history，latest 同步
  const history = Array.isArray(existing.history) ? existing.history : [];
  // 同 capturedAt 的旧快照不重复追加（同一 run 重写场景）
  const filtered = history.filter((h) => h?.capturedAt !== snapshot.capturedAt);
  filtered.push(snapshot);
  const out = { ...existing, awemeId: snapshot.awemeId, history: filtered, latest: snapshot };
  await writeJson(path, out);
  return { merged: true, length: filtered.length };
}

// ------------------------------------------------------------------
// comments.json（合并去重）
// ------------------------------------------------------------------

/**
 * @param {string} workDir
 * @param {{
 *   awemeId: string,
 *   collectedAt: string,
 *   incomplete: boolean,
 *   truncatedReason: string|null,
 *   items: Array<any>
 * }} payload
 * @param {{ force?: boolean }} [opts]
 */
export async function writeComments(workDir, payload, opts = {}) {
  await ensureDir(workDir);
  const path = join(workDir, 'comments.json');
  const existing = await readJsonSafe(path, null);

  if (opts.force || !existing) {
    await writeJson(path, payload);
    return { merged: false, length: payload.items.length };
  }

  // 合并：按 commentId 去重；新评论 append；已存在但 likeCount 更高的更新
  const byId = new Map();
  for (const it of existing.items ?? []) {
    if (it?.commentId) byId.set(it.commentId, it);
  }
  let added = 0;
  let updated = 0;
  for (const it of payload.items) {
    if (!it?.commentId) continue;
    const prev = byId.get(it.commentId);
    if (!prev) {
      byId.set(it.commentId, it);
      added += 1;
    } else if (
      typeof it.likeCount === 'number' &&
      (typeof prev.likeCount !== 'number' || it.likeCount > prev.likeCount)
    ) {
      byId.set(it.commentId, { ...prev, likeCount: it.likeCount });
      updated += 1;
    }
  }
  const mergedItems = [...byId.values()];
  const out = {
    ...existing,
    awemeId: payload.awemeId,
    collectedAt: payload.collectedAt, // 始终刷新本次时间
    incomplete: payload.incomplete,   // 最新一次抓取的结果
    truncatedReason: payload.truncatedReason,
    count: mergedItems.length,
    items: mergedItems,
  };
  await writeJson(path, out);
  return { merged: true, length: mergedItems.length, added, updated };
}

// ------------------------------------------------------------------
// 失败记录
// ------------------------------------------------------------------

/**
 * @param {string} workDir
 * @param {{ awemeId: string, stage: string, errorCode: string, errorMessage: string }} failure
 */
export async function writeFailure(workDir, failure) {
  await ensureDir(workDir);
  const failed = await readJsonSafe(join(workDir, '_FAILED.json'), null);
  // 同阶段失败覆盖；不同阶段追加
  if (failed && failed.stage === failure.stage) {
    await writeJson(join(workDir, '_FAILED.json'), {
      ...failure,
      failedAt: new Date().toISOString(),
    });
  } else {
    await writeJson(join(workDir, '_FAILED.json'), {
      ...failure,
      failedAt: new Date().toISOString(),
    });
  }
}

/**
 * 成功后清除 _FAILED.json（避免下次看到上次失败的陈旧记录）。
 */
export async function clearFailure(workDir) {
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(join(workDir, '_FAILED.json'));
  } catch {
    // 文件本来就没有 → OK
  }
}

// ------------------------------------------------------------------
// _run.json（本次运行元信息）
// ------------------------------------------------------------------

export async function writeRun(workDir, payload) {
  await ensureDir(workDir);
  await writeJson(join(workDir, '_run.json'), payload);
}

// ------------------------------------------------------------------
// _index.json（顶层汇总）
// ------------------------------------------------------------------

/**
 * @param {string} root   ~/moonlit-creator/works/douyin/
 * @param {{
 *   accountId: string,
 *   totals: { works: number, comments: number },
 *   works: Array<{awemeId, title, publishedAt, shareUrl, commentsCount, path}>
 * }} payload
 */
export async function writeIndex(root, payload) {
  await ensureDir(root);
  const works = [];
  for (const work of payload.works ?? []) {
    const dir = await resolveWorkDir(root, work.awemeId, work.title ?? '', payload.accountId);
    works.push({ ...work, path: relative(root, dir) + '/' });
  }
  await writeJson(join(root, '_index.json'), {
    updatedAt: new Date().toISOString(),
    accountId: payload.accountId,
    totals: payload.totals,
    works,
  });
}

// ------------------------------------------------------------------
// 读取 _FAILED.json 列表（--resume 用）
// ------------------------------------------------------------------

/**
 * 列出所有 _FAILED.json 的作品 ID。
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function listFailedWorks(root) {
  /** @type {string[]} */
  const failed = [];
  const index = await readJsonSafe(join(root, '_index.json'), null);
  if (index?.works?.length) {
    for (const item of index.works) {
      if (!item?.path) continue;
      const meta = await readJsonSafe(join(root, item.path, '_FAILED.json'), null);
      if (meta?.awemeId) failed.push(meta.awemeId);
    }
    return failed;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return failed;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = await readJsonSafe(join(dir, '_FAILED.json'), null);
    if (meta?.awemeId) failed.push(meta.awemeId);
  }
  return failed;
}

// ------------------------------------------------------------------
// 读取已有 meta.json（resume 用）
// ------------------------------------------------------------------

/**
 * @param {string} root
 * @param {string} awemeId
 * @returns {Promise<object|null>}
 */
export async function readMeta(root, awemeId) {
  const direct = await readJsonSafe(join(root, awemeId, 'meta.json'), null);
  if (direct) return direct;
  const index = await readJsonSafe(join(root, '_index.json'), null);
  const item = index?.works?.find((w) => w.awemeId === awemeId);
  if (!item?.path) return null;
  return readJsonSafe(join(root, item.path, 'meta.json'), null);
}
