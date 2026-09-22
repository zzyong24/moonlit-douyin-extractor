// 月明·抖音萃取 · 纯函数单测
// 跑法：node scripts/src/parsers.test.mjs
//
// 不依赖 Playwright / 浏览器 / 网络，验证：
//   - parseWorkList 能从抖音 XHR JSON 抽到作品 + 指标
//   - parseCommentList 能从评论 XHR 抽到评论
//   - deriveTitle 短标题派生正确
//   - toIsoFromUnixSeconds 时间戳转换
//   - readHasMore 多键兜底
//   - 兜底字段不崩（脏数据不污染结果）

import assert from 'node:assert/strict';
import {
  parseWorkList,
  parseCommentList,
  readHasMore,
  deriveTitle,
  toIsoFromUnixSeconds,
  DERIVED_TITLE_MAX,
} from './parsers.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`        ${e.message}`);
  }
}

// ============================================================
// parseWorkList
// ============================================================

console.log('parseWorkList');

test('aweme_list 顶层 + 完整字段', () => {
  const json = {
    status_code: 0,
    aweme_list: [
      {
        aweme_id: '7400',
        title: '从一张图到 2D 肉鸽游戏',
        desc: '完整文案\n多行\ncaption',
        create_time: 1757654400,
        video: { duration: 187000 }, // ms
        statistics: {
          play_count: 128000,
          digg_count: 5400,
          comment_count: 327,
          share_count: 89,
          collect_count: 432,
        },
        author: {
          nickname: '月色创作者',
          sec_uid: 'MS4wsecuid',
        },
      },
    ],
  };
  const out = parseWorkList(json);
  assert.equal(out.length, 1);
  const w = out[0];
  assert.equal(w.awemeId, '7400');
  assert.equal(w.title, '从一张图到 2D 肉鸽游戏');
  assert.equal(w.desc, '完整文案\n多行\ncaption');
  assert.equal(w.durationSec, 187);
  assert.equal(w.stats.views, 128000);
  assert.equal(w.stats.likes, 5400);
  assert.equal(w.stats.comments, 327);
  assert.equal(w.stats.shares, 89);
  assert.equal(w.stats.favorites, 432);
});

test('item_list 顶层 + 字段 key 兜底（play vs play_count）', () => {
  const json = {
    status_code: 0,
    item_list: [
      {
        item_id: '7401',
        title: '',
        desc: '',
        create_time: 0,
        video: { duration: 5000 },
        stats: {
          play: 100,         // 不是 play_count
          like_count: 5,     // 不是 digg_count
          collect: 2,        // 不是 collect_count
        },
      },
    ],
  };
  const out = parseWorkList(json);
  assert.equal(out.length, 1);
  assert.equal(out[0].awemeId, '7401');
  assert.equal(out[0].stats.views, 100);
  assert.equal(out[0].stats.likes, 5);
  assert.equal(out[0].stats.favorites, 2);
  assert.equal(out[0].stats.shares, 0);
  assert.equal(out[0].stats.comments, 0);
});

test('嵌套 data.aweme_list', () => {
  const json = { data: { aweme_list: [{ aweme_id: 'a', statistics: {} }] } };
  assert.equal(parseWorkList(json).length, 1);
});

test('无作品列表返回空数组', () => {
  assert.equal(parseWorkList({}).length, 0);
  assert.equal(parseWorkList({ data: {} }).length, 0);
  assert.equal(parseWorkList(null).length, 0);
});

test('无 aweme_id 的脏数据丢弃', () => {
  const json = {
    aweme_list: [
      { aweme_id: '7400', statistics: {} },
      { statistics: {} },                      // 无 id
      { id: '7402', statistics: {} },          // item_id → aweme_id
      { aweme_id: '', statistics: {} },        // 空 id
      null,
    ],
  };
  const out = parseWorkList(json);
  assert.equal(out.length, 2); // 7400 + 7402
  assert.deepEqual(out.map((w) => w.awemeId), ['7400', '7402']);
});

test('duration 字段缺失时兜底为 0', () => {
  const json = { aweme_list: [{ aweme_id: 'a', statistics: {} }] };
  assert.equal(parseWorkList(json)[0].durationSec, 0);
});

test('数字字段是字符串也能解析（去逗号、去空白）', () => {
  const json = {
    aweme_list: [{
      aweme_id: 'a',
      create_time: 1757654400,
      statistics: {
        play_count: '128,000',
        digg_count: ' 5,400 ',
      },
    }],
  };
  const w = parseWorkList(json)[0];
  assert.equal(w.stats.views, 128000);
  assert.equal(w.stats.likes, 5400);
});

// ============================================================
// parseCommentList
// ============================================================

console.log('parseCommentList');

test('comments 顶层 + cid + text + digg_count', () => {
  const json = {
    status_code: 0,
    comments: [
      {
        cid: 'c1',
        aweme_id: '7400',
        text: '哥你这游戏在哪能玩？',
        digg_count: 12,
        reply_comment_total: 2,
        create_time: 1725621240,
        user: { uid: 'u1', nickname: '创作者A' },
        ip_label: '上海',
      },
    ],
  };
  const out = parseCommentList(json, '7400');
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.commentId, 'c1');
  assert.equal(c.awemeId, '7400');
  assert.equal(c.text, '哥你这游戏在哪能玩？');
  assert.equal(c.likeCount, 12);
  assert.equal(c.replyCount, 2);
  assert.equal(c.createTime, 1725621240);
  assert.equal(c.userId, 'u1');
  assert.equal(c.userName, '创作者A');
  assert.equal(c.ipLabel, '上海');
});

test('comment_id / id 兜底', () => {
  const json = {
    comment_list: [
      { id: 'x', text: 'hello', user: { name: 'A' } },
      { comment_id: 'y', text: 'world', user: { name: 'B' } },
    ],
  };
  const out = parseCommentList(json, 'a');
  assert.deepEqual(out.map((c) => c.commentId), ['x', 'y']);
});

test('嵌套 data.comments', () => {
  const json = { data: { comments: [{ cid: 'a', text: 'hi' }] } };
  assert.equal(parseCommentList(json).length, 1);
});

test('无 commentId 或 text 的脏数据丢弃', () => {
  const json = {
    comments: [
      { cid: 'c1', text: 'good' },
      { cid: 'c2', text: '' },               // 空 text
      { cid: 'c3', text: '   ' },           // 仅空白
      { text: 'no id' },                     // 无 cid
      { cid: 'c4' },                          // 无 text
      null,
    ],
  };
  const out = parseCommentList(json);
  assert.equal(out.length, 1);
  assert.equal(out[0].commentId, 'c1');
});

test('aweme_id 缺失回退 defaultAwemeId', () => {
  const json = { comments: [{ cid: 'c1', text: 'hi', user: { name: 'A' } }] };
  const out = parseCommentList(json, 'fallback-id');
  assert.equal(out[0].awemeId, 'fallback-id');
});

test('user 字段缺失时 userName/userId 为空串', () => {
  const json = { comments: [{ cid: 'c1', text: 'hi' }] };
  const c = parseCommentList(json)[0];
  assert.equal(c.userId, '');
  assert.equal(c.userName, '');
});

// ============================================================
// readHasMore
// ============================================================

console.log('readHasMore');

test('顶层 has_more', () => {
  assert.equal(readHasMore({ has_more: true }), true);
  assert.equal(readHasMore({ has_more: false }), false);
});

test('data.has_more 兜底', () => {
  assert.equal(readHasMore({ data: { has_more: true } }), true);
  assert.equal(readHasMore({ data: { has_more: false } }), false);
});

test('hasMore camelCase 兜底', () => {
  assert.equal(readHasMore({ hasMore: true }), true);
});

test('缺字段返 undefined', () => {
  assert.equal(readHasMore({}), undefined);
  assert.equal(readHasMore({ has_more: null }), undefined);
});

// ============================================================
// deriveTitle
// ============================================================

console.log('deriveTitle');

test('官方 title 非空 → 原样', () => {
  assert.equal(deriveTitle('真标题', 'desc 第一行'), '真标题');
});

test('官方 title 空 → desc 首行', () => {
  assert.equal(deriveTitle('', 'desc 第一行\n第二行'), 'desc 第一行');
  assert.equal(deriveTitle('   ', 'desc 第一行'), 'desc 第一行');
});

test('desc 极长首行 → 截 40 码元', () => {
  const long = 'a'.repeat(100);
  const out = deriveTitle('', long);
  assert.equal(out.length, DERIVED_TITLE_MAX);
});

test('emoji 串不会被劈半个（保留整数个 emoji）', () => {
  // 🎉 (U+1F389) 是 1 个码元 = 2 个 UTF-16 code unit；20 个 🎉 = 40 code unit。
  // deriveTitle 用 `[...trimmed].slice(0, 40)`：spread 按 code point 拆，
  // 所以 20 个 emoji 拆成 20 个元素，slice(0, 40) 取全部 20 个 → 输出 .length = 40。
  // 关键断言：输出不含"半个 emoji"，保留整数个 emoji。
  const out = deriveTitle('', '🎉'.repeat(20));
  // 用 unicode flag 让正则按码元匹配（emoji = 1 个码元，'🎉+' = 1+ 个 emoji）
  assert.match(out, /^🎉+$/u);
  assert.equal([...out].length, 20);              // 20 个码元
  assert.equal(out.length, 40);                    // 40 个 UTF-16 code unit
});

test('title + desc 都空 → 空串', () => {
  assert.equal(deriveTitle('', ''), '');
  assert.equal(deriveTitle(undefined, undefined), '');
});

// ============================================================
// toIsoFromUnixSeconds
// ============================================================

console.log('toIsoFromUnixSeconds');

test('正常时间戳', () => {
  const iso = toIsoFromUnixSeconds(1725621240);
  assert.equal(typeof iso, 'string');
  assert.equal(iso.startsWith('2024-09-06'), true);
});

test('0 / 负数 / NaN / 字符串 → null', () => {
  assert.equal(toIsoFromUnixSeconds(0), null);
  assert.equal(toIsoFromUnixSeconds(-1), null);
  assert.equal(toIsoFromUnixSeconds(NaN), null);
  assert.equal(toIsoFromUnixSeconds('not a number'), null);
  assert.equal(toIsoFromUnixSeconds(undefined), null);
});

// ============================================================
// 总结
// ============================================================

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);