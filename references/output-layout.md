# 输出目录与作品命名

抖音抓取结果归档到真实作品目录：`works/YYYY/W-YYYYMMDD-NNN-xxx/distribution/douyin/<awemeId>/`。`works/douyin/` 只保留 `_index.json` 汇总；暂时无法匹配作品的历史视频进入 `works/douyin/_unassigned/<awemeId>/`，等待补充 `work.json.platformIds.douyin`。

## 目录结构

```
~/moonlit-creator/works/2026/W-YYYYMMDD-NNN-作品名/distribution/douyin/
├── <awemeId>/
│   ├── meta.json              ← 作品元数据（必有）
│   ├── metrics.json           ← 指标快照（必有，可空）
│   ├── comments.json          ← 评论列表（必有，可空）
│   ├── _run.json              ← 本次抓取元信息（指标/评论各自的 run time + 来源）
│   └── _FAILED.json           ← 仅失败时存在
└── _index.json                ← 全量作品索引（每次 run 末尾重写）
```

每个 `<awemeId>` 目录代表一个抖音视频，独立、可单独读、可单独删。

## 文件约定

### `meta.json`

作品身份信息；**不含昵称 / 抖音号 / sec_uid**（避免隐私泄漏）。

```json
{
  "awemeId": "7523456789012345678",
  "title": "从一张图到 2D 肉鸽游戏",
  "desc": "完整 caption 全文（含换行）",
  "durationSec": 312,
  "publishedAt": "2026-09-06T12:34:00.000Z",
  "shareUrl": "https://www.douyin.com/video/7523456789012345678",
  "capturedAt": "2026-09-11T03:14:15.000Z"
}
```

字段映射：见 [data-shape.md](data-shape.md)。

### `metrics.json`

作品指标快照（创作者中心 work_list XHR）。结构上 `history[]` 数组保留所有快照，`latest` 始终是最新一份。

```json
{
  "awemeId": "7523456789012345678",
  "history": [
    { "capturedAt": "...", "metrics": {...}, "source": "creator-center-work-list" }
  ],
  "latest": { "capturedAt": "...", "metrics": {...}, "source": "..." }
}
```

字段名口径见 [data-shape.md](data-shape.md)。`source` 标识本 Skill 的来源（`creator-center-work-list`）。

### `comments.json`

评论列表。空数组合法（作品本身 0 评）。`incomplete` 必须给出是否完整，`truncatedReason` 在截断时注明。

```json
{
  "awemeId": "7523456789012345678",
  "collectedAt": "2026-09-11T03:18:42.000Z",
  "incomplete": false,
  "truncatedReason": null,
  "count": 327,
  "items": [
    {
      "commentId": "9876543210987654321",
      "awemeId": "7523456789012345678",
      "text": "哥你这游戏在哪能玩？",
      "likeCount": 12,
      "replyCount": 2,
      "createTime": 1725621240,
      "userId": "u-1234",
      "userName": "创作者A",
      "ipLabel": "上海"
    }
  ]
}
```

### `_run.json`

本次抓取运行元信息（用于审计 + 复现）。

```json
{
  "accountId": "default",
  "metricsRun": {
    "startedAt": "2026-09-11T03:14:00.000Z",
    "completedAt": "2026-09-11T03:14:15.000Z",
    "pagesScanned": 1
  },
  "commentsRun": {
    "startedAt": "2026-09-11T03:17:00.000Z",
    "completedAt": "2026-09-11T03:18:42.000Z",
    "worksScanned": 23,
    "truncated": false,
    "truncatedReason": null
  },
  "totals": {
    "metricsWritten": 23,
    "commentsWritten": 327
  }
}
```

### `_FAILED.json`

仅当某作品抓取失败时存在。**禁止写半截 metrics.json / comments.json**。

```json
{
  "awemeId": "7523456789012345678",
  "failedAt": "2026-09-11T03:14:30.000Z",
  "stage": "comments",
  "errorCode": "DouyinNotLoggedInError",
  "errorMessage": "sessionid cookie 失效，需重跑 --login-only 重扫"
}
```

### `_index.json`

汇总本次 run 的所有作品；放在 `works/douyin/_index.json` 顶层。供其他 Skill 起步读取：

```json
{
  "updatedAt": "2026-09-11T03:19:00.000Z",
  "accountId": "default",
  "totals": {
    "works": 23,
    "comments": 327
  },
  "works": [
    {
      "awemeId": "7523456789012345678",
      "title": "从一张图到 2D 肉鸽游戏",
      "publishedAt": "2026-09-06T12:34:00.000Z",
      "shareUrl": "https://www.douyin.com/video/7523456789012345678",
      "metrics": { "...": "..." },
      "commentsCount": 327,
      "path": "7523456789012345678/"
    }
  ]
}
```

## 与 moonlit-creator work 体系的关系

抖音数据是作品的下游分发证据，不进入 `works/index.json` 的作品生命周期，但和作品放在同一作品目录下：

映射写在作品 `work.json` 的 `platformIds.douyin` 数组中，采集 Skill 据此归档。

## 文件覆盖策略

| 目标文件 | 同名已存在 | 行为 |
|---|---|---|
| `meta.json` | 是 | 覆盖（标题/发布时间可能微调；任何时刻都反映抖音服务端真相） |
| `metrics.json` | 是 | 默认**追加新快照到 metrics.json.history**（`history[]`），不丢历史；除非 `--force` 才覆盖主文件 |
| `comments.json` | 是 | 默认合并去重（同 `commentId` 不重复写）；除非 `--force` 才覆盖 |
| `_run.json` | 是 | 每次重写（仅反映本次） |
| `_FAILED.json` | 是 | 仅在失败时写；上次成功的同名文件保持不动 |
| `_index.json` | 是 | 每次重写 |

这样默认行为下可以**重复跑、不会丢历史指标 / 评论**。需要重置用 `--reset` 标记。
