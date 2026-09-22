// 月明·抖音萃取 · 纯函数解析器
//
// 这一组函数不碰浏览器 / 不碰文件系统。可单测。逻辑忠实移植自
// Thirdspace-creator: frontend/src/server/ingestion/douyin-cdp.ts
// 中的 parseWorkList / parseCommentList / deriveWorkTitle，简化为 standalone Node ESM，
// 不依赖任何 TypeScript / pnpm monorepo。
//
// 字段名兜底：抖音端点在不同时间可能换 key（如 play_count vs play），多处匹配。

// ------------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------------

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

export const DERIVED_TITLE_MAX = 40;

// 短标题派生：官方 title 非空 → 原样；空 → desc 首行截 40 字
export function deriveTitle(title, desc) {
  const official = (title ?? '').trim();
  if (official) return official;
  const firstLine = (desc ?? '').split(/[\r\n]/)[0] ?? '';
  const trimmed = firstLine.trim();
  // 按码点截，避免 emoji 代理对被劈半
  return [...trimmed].slice(0, DERIVED_TITLE_MAX).join('');
}

// 抖音 create_time 是 unix 秒；本地用 ISO 字符串
export function toIsoFromUnixSeconds(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
  return new Date(sec * 1000).toISOString();
}

// ------------------------------------------------------------------
// 作品列表解析：创作者中心 work_list XHR
// ------------------------------------------------------------------

/**
 * @typedef {{
 *   awemeId: string,
 *   title: string,
 *   desc: string,
 *   durationSec: number,
 *   createTime: number,
 *   stats: {
 *     views: number,
 *     likes: number,
 *     comments: number,
 *     shares: number,
 *     favorites: number
 *   }
 * }} DouyinWork
 */

/**
 * 解析 work_list JSON；不命中作品 ID 的脏数据丢弃。
 * @param {unknown} json
 * @returns {DouyinWork[]}
 */
export function parseWorkList(json) {
  const root = (json ?? {}) || {};
  const data = root.data || {};
  const list =
    (Array.isArray(root.aweme_list) && root.aweme_list) ||
    (Array.isArray(root.item_list) && root.item_list) ||
    (Array.isArray(data.aweme_list) && data.aweme_list) ||
    (Array.isArray(data.item_list) && data.item_list) ||
    [];
  return list
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const awemeId = str(raw.aweme_id) || str(raw.item_id) || str(raw.id);
      if (!awemeId) return null;
      const s = raw.statistics || raw.stats || {};
      const video = raw.video || {};
      return {
        awemeId,
        title: str(raw.title),
        desc: str(raw.desc),
        createTime: num(raw.create_time),
        durationSec:
          Math.round(num(video.duration) / 1000) || num(video.duration),
        stats: {
          views: num(s.play_count ?? s.play ?? s.vv),
          likes: num(s.digg_count ?? s.like_count ?? s.digg),
          comments: num(s.comment_count ?? s.comment),
          shares: num(s.share_count ?? s.share),
          favorites: num(s.collect_count ?? s.favorite_count ?? s.collect),
        },
      };
    })
    .filter((w) => w !== null);
}

/**
 * work_list 顶层的 has_more 字段兜底抽取
 * @param {unknown} json
 * @returns {boolean | undefined}
 */
export function readHasMore(json) {
  const root = (json ?? {}) || {};
  const data = root.data || root;
  const v = root.has_more ?? data.has_more ?? root.hasMore ?? data.hasMore;
  return typeof v === 'boolean' ? v : v == null ? undefined : Boolean(v);
}

// ------------------------------------------------------------------
// 评论列表解析：创作者中心评论管理页 XHR
// ------------------------------------------------------------------

/**
 * @typedef {{
 *   commentId: string,
 *   awemeId: string,
 *   text: string,
 *   likeCount: number,
 *   replyCount: number,
 *   createTime: number,
 *   userId: string,
 *   userName: string,
 *   ipLabel: string
 * }} CommentRecord
 */

/**
 * 解析评论 JSON。无 commentId 或无正文的脏数据丢弃。
 * @param {unknown} json
 * @param {string} [defaultAwemeId]
 * @returns {CommentRecord[]}
 */
export function parseCommentList(json, defaultAwemeId = '') {
  const root = (json ?? {}) || {};
  const data = root.data || {};
  const list =
    (Array.isArray(root.comments) && root.comments) ||
    (Array.isArray(root.comment_list) && root.comment_list) ||
    (Array.isArray(data.comments) && data.comments) ||
    (Array.isArray(data.comment_list) && data.comment_list) ||
    [];
  return list
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const commentId = str(raw.cid) || str(raw.comment_id) || str(raw.id);
      const text = str(raw.text) || str(raw.content);
      if (!commentId || !text.trim()) return null;
      const user = raw.user || raw.user_info || {};
      return {
        commentId,
        awemeId: str(raw.aweme_id) || str(raw.item_id) || defaultAwemeId,
        text,
        likeCount: num(raw.digg_count ?? raw.like_count),
        replyCount: num(raw.reply_comment_total ?? raw.reply_count),
        createTime: num(raw.create_time),
        userId: str(user.uid) || str(user.user_id) || str(raw.user_id),
        userName:
          str(user.nickname) || str(user.name) || str(raw.user_name),
        ipLabel: str(raw.ip_label) || str(raw.ip_location),
      };
    })
    .filter((c) => c !== null);
}