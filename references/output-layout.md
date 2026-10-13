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

`--max-pages`同时传入单作品及批量评论读取。`coverage`声明当前顶层范围、实际响应页数、滚动轮数、预算、cursor与top_has_more；没有响应、结束标记未知、混入其他视频或预算用尽都不能称完整。顶层与展开回复独立报告；creator接口展开回复保存parentCommentId、原ID、has_more/cursor和每父评论的覆盖。web代理路径的list/reply响应同样按真实parent ID采集；未知回复数量或未确认末页仍留缺口，不能称全部完成。平台拒绝停止后续作品。失败/空截断合并已有评论时保留原collectedAt，并以lastAttemptAt记录本次尝试，不能给旧数据刷新成功日期。

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

只刷评论仍保留当前账号的作品条目及已有指标；目标按稳定ID从索引或真实meta/metrics文件恢复，不把空的指标采集目标写回索引。`metricsWritten`在该模式为0，评论计数按实际结果记录。输出根经兼容链接访问时，索引相对路径以实际保存目录为基准，不能指向迁移前的目录层级。


## 新接口与运行结果（2026-10-04）

creator 接口返回 `comment_info_list`，作品/评论 ID 为平台的 opaque ID。作品用真实 `item_info_list` 的 `item_id_plain` 核对，原评论 ID 保留；无文字的图片/表情记录保存为空正文和 `contentKind=non_text`，不假装没有这条评论。未解析到指标列表就失败，不以 0 条作品覆盖索引；指标缺字段为 null，只有显式数值 0 才是零。

不同接口的评论 ID 不能按正文猜成同一个人或当成新增需求。namespace 改变时，将旧原始观察保存在 comments.json 的只读历史 `alternateCollections`，当前集合沿用新接口 ID；不叠加两路 count。空失败仍保留旧时间与内容。

`_run_comments.json/_run.json` 记录 attempted、topCompleted、collected、notAttempted、status 与逐视频 coverage。`collected` 是本次完整范围数，不是处理过的页面数。顶层和回复缺口保存 `_FAILED.json`，指标成功不得清除评论失败标记。部分完成退出码 6；只针对失败项恢复，平台拒绝或会话失效停止当前账号。已经采到的正文在后续界面失败时仍保存，不能整批丢弃。


`_creator-item-map.json`只保存经本人身份核验后真实item_info_list提供的作品opaque ID与item_id_plain对应，不含凭据。跨运行复用同账号稳定映射，保留每条observedAt；新的平台响应才能更新对应读取时间。当前评论仍须读到实际响应且请求ID与映射匹配，映射本身不充当评论采集成功。后台壳/作品抽屉需等实际数据，回复需等实际XHR，不能用固定4秒推断无回复。HTTP403/429及平台拒绝立即停止该账号；不为恢复更换凭据或账号。
