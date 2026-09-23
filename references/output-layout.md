# 按账号隔离的输出结构

每个账号别名有自己的输出根、索引和未匹配作品：

```text
~/moonlit-creator/works/douyin/<accountId>/
├── _account.json             ← 输出根所属账号
├── _index.json               ← 这个账号最近一次采集的作品索引
├── _run_metrics.json          ← 指标采集运行结果
├── _run_comments.json         ← 评论采集运行结果
└── _unassigned/<awemeId>/     ← 暂时未映射到 Workbase 作品的内容
```

如果 Workbase `work.json` 的 `platformIds.douyin` 包含该作品 ID，则数据写到：

```text
~/moonlit-creator/works/<year>/<work>/distribution/douyin/<accountId>/<awemeId>/
├── meta.json
├── metrics.json
├── comments.json
└── _FAILED.json               ← 仅本作品本次处理失败时存在
```

别名目录隔开不同账号在同一个 Workbase 作品下的数据。映射只认稳定的 `awemeId`；标题相似或相同不能建立作品归属。输出根 `_account.json` 保护未映射数据和索引：账号别名不符或遇到未标记的旧数据时，脚本拒绝写入。旧版目录不会自动迁移。

## `meta.json`

作品元数据含本机账号别名与平台作品 ID，不包含昵称、抖音号或原始 `sec_uid`。

```json
{
  "accountId": "main",
  "awemeId": "7523456789012345678",
  "title": "从一张图到 2D 肉鸽游戏",
  "desc": "完整 caption 全文",
  "durationSec": 312,
  "publishedAt": "2026-09-06T12:34:00.000Z",
  "shareUrl": "https://www.douyin.com/video/7523456789012345678",
  "capturedAt": "2026-09-23T03:14:15.000Z"
}
```

## `metrics.json`

按次追加历史快照；`latest` 指向最新一次。具体字段口径见 [data-shape.md](data-shape.md)。

```json
{
  "awemeId": "7523456789012345678",
  "history": [
    { "capturedAt": "...", "metrics": { "views": 0, "likes": 0 }, "source": "creator-center-work-list" }
  ],
  "latest": { "capturedAt": "...", "metrics": { "views": 0, "likes": 0 }, "source": "creator-center-work-list" }
}
```

示例里的 `0` 表示合法的真实零值；源字段缺失时按字段契约保留缺失/null，不得补写 0。

## `comments.json`

空数组可以表示合法的零评论；网络截断或冷却时必须留下 `incomplete` 和 `truncatedReason`。评论可能含用户名称、用户 ID 与 IP 归属，属于敏感运行数据。

```json
{
  "awemeId": "7523456789012345678",
  "collectedAt": "2026-09-23T03:18:42.000Z",
  "incomplete": false,
  "truncatedReason": null,
  "count": 0,
  "items": []
}
```

## `_index.json`

账号专属索引位于 `works/douyin/<accountId>/_index.json`，条目中的 `accountId` 与根目录别名一致，`path` 相对于该输出根。

```json
{
  "updatedAt": "2026-09-23T03:19:00.000Z",
  "accountId": "main",
  "totals": { "works": 1, "comments": 0 },
  "works": [
    {
      "awemeId": "7523456789012345678",
      "title": "从一张图到 2D 肉鸽游戏",
      "publishedAt": "2026-09-06T12:34:00.000Z",
      "shareUrl": "https://www.douyin.com/video/7523456789012345678",
      "commentsCount": 0,
      "path": "../../../../2026/W-.../distribution/douyin/main/7523456789012345678/"
    }
  ]
}
```

## 重复运行与错误

| 文件 | 已存在时的行为 |
|---|---|
| `meta.json` | 更新平台元数据，保留 `accountId` |
| `metrics.json` | 默认追加快照到 `history[]`；同一采集时间不重复追加；`--force` 才替换历史 |
| `comments.json` | 默认按 `commentId` 合并；`--force` 才替换 |
| `_index.json` | 仅重写当前别名的索引 |
| `_FAILED.json` | 记录该作品失败阶段；成功重试后移除 |
| `_run_metrics.json` / `_run_comments.json` | 保存当前别名的运行摘要 |

账号注册表、profile、输出 marker 和作品数据均属于使用者本机运行状态，不进入开源仓库。复制输出目录时应保留账号别名层级，避免丢失归属信息。
