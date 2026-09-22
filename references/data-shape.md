# 字段映射：抖音 → 本地 JSON

本表记录**抖音 XHR 字段 → 本地落盘字段**的映射。所有字段都按"宁缺毋滥"原则：抓不到就空着，不编。

## 1. 作品元数据 `meta.json`

来自创作者中心 work_list XHR（`/aweme/v1/creator/item/list` → `aweme_list[]`）：

| 本地字段 | 来源字段 | 类型 | 必填 | 兜底 |
|---|---|---|---|---|
| `awemeId` | `aweme_id` \| `item_id` \| `id` | string | ✅ | 跳过该作品 |
| `title` | `title` | string | 是 | 空串 `""` |
| `desc` | `desc` | string | 是 | 空串 `""` |
| `durationSec` | `video.duration`（ms）÷ 1000 | number | 是 | 0 |
| `publishedAt` | `create_time`（秒）× 1000 → ISO | string | 是 | `null`（缺失时） |
| `shareUrl` | 派生 | string | 是 | `https://www.douyin.com/video/<awemeId>` |
| `capturedAt` | 脚本采集时刻 | string | ✅ | - |

### `title` 派生（短标题规则）

- 官方 `title` 非空 → 原样用
- 空 → 取 `desc` 第一行去首尾空白，按码点截 40 字（避免 emoji 代理对被劈半）

**不写**：`nickname` / `sec_uid` / `unique_id` / `follower_count` —— 这些属于账号隐私，不进 meta.json。

## 2. 作品指标 `metrics.json`

| 本地字段 | 来源字段 | 类型 | 兜底 |
|---|---|---|---|
| `metrics.views` | `statistics.play_count` \| `play` \| `vv` | number | 0 |
| `metrics.likes` | `statistics.digg_count` \| `like_count` \| `digg` | number | 0 |
| `metrics.comments` | `statistics.comment_count` \| `comment` | number | 0 |
| `metrics.shares` | `statistics.share_count` \| `share` | number | 0 |
| `metrics.favorites` | `statistics.collect_count` \| `favorite_count` \| `collect` | number | 0 |
| `capturedAt` | 脚本采集时刻 | string | - |
| `source` | 固定 `"creator-center-work-list"` | string | - |

### 历史快照

`metrics.json` 默认结构：

```json
{
  "awemeId": "...",
  "history": [
    { "capturedAt": "...", "metrics": {...}, "source": "..." },
    { "capturedAt": "...", "metrics": {...}, "source": "..." }
  ],
  "latest": { "capturedAt": "...", "metrics": {...}, "source": "..." }
}
```

`latest` 始终等于 `history[history.length - 1]`。这样下游消费者可以一眼拿到最新值，又不丢历史。

## 3. 评论 `comments.json`

来自创作者中心评论管理页 XHR（`/aweme/v1/web/comment/list/`）：

| 本地字段 | 来源字段 | 类型 | 兜底 |
|---|---|---|---|
| `commentId` | `cid` \| `comment_id` \| `id` | string | 跳过该评论 |
| `awemeId` | `aweme_id` \| `item_id` \| 默认作品 awemeId | string | 必填 |
| `text` | `text` \| `content` | string | 跳过（无正文的脏数据） |
| `likeCount` | `digg_count` \| `like_count` | number | 0 |
| `replyCount` | `reply_comment_total` \| `reply_count` | number | 0 |
| `createTime` | `create_time`（秒） | number | 0 |
| `userId` | `user.uid` \| `user.user_id` \| 顶层 `user_id` | string | 空串 |
| `userName` | `user.nickname` \| `user.name` \| 顶层 `user_name` | string | 空串 |
| `ipLabel` | `ip_label` \| `ip_location` | string | 空串 |

### 顶层字段

| 本地字段 | 说明 |
|---|---|
| `awemeId` | 必填，对应作品 |
| `collectedAt` | 本次抓取时刻 ISO |
| `incomplete` | `boolean`，是否完整抓完该作品所有评论 |
| `truncatedReason` | `string \| null`，截断原因（如"撞冷却截断：已采 X/Y"） |
| `count` | `items.length` |
| `items` | 评论数组 |

### 评论合并去重

多次跑同一作品时，按 `commentId` 去重：
- 已在 `comments.items` 的 commentId → 跳过
- 新增的 → append
- 已存在 commentId 但 `likeCount` 更高 → 更新 `likeCount`（评论点赞数会涨）

## 4. 兜底原则

任何字段抓不到 → 写 `null`（保留键）或 `0`（数字字段）；**禁止编造**。

例：`durationSec` 抓不到 → 写 `0`（数字字段约定），不要写 `null`。

`title` / `desc` 抓不到 → 写 `""`（字符串字段约定），不要写 `null`。

`publishedAt` 抓不到 → 写 `null`（必填字段缺失要让下游警觉）。

## 5. 端点参考

| 数据 | 端点 |
|---|---|
| 作品指标 | `/aweme/v1/creator/item/list`（含兜底：`/creator/pc/work_list`、`/web/aweme/post`） |
| 评论 | `/aweme/v1/web/comment/list/`（带 `item_id=<awemeId>` 过滤） |
| 登录态探针 | `/aweme/v1/creator/user/info/` |

`fetchDouyinMetrics` 用 `WORK_LIST_HINTS` 三个端点任一命中即接收；`fetchDouyinComments` 仅命中 `/aweme/v1/web/comment/list/`。