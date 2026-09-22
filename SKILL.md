---
name: moonlit-douyin-extractor
description: Use when 月明需要从抖音创作者中心抓取自己账号的作品指标（播放/点赞/评论数/分享/收藏/时长/发布时间/标题）和作品评论（用户/正文/点赞数/时间/IP 归属），按作品归档到 `works/YYYY/W-.../distribution/douyin/`，作为后续选题、复盘和素材的原始语料。登录阶段调用 ego-browser 的可见持久页面扫码，采集阶段使用独立的 Playwright profile 复用 cookie；不依赖 CreatorOS。仅供个人账号采集，不抓他人作品、不抓热搜/收藏夹。
metadata:
  display_name: 月明·抖音萃取
  icon: icon.svg
  updated: "2026-09-11"
---

# 🌙 moonlit-douyin-extractor · 抖音作品与评论萃取

把抖音创作者中心已发布作品的**真实指标 + 真实评论**按作品切分，落到本地文件系统，供后续选题雷达（moonlit-topic-radar）、复盘（moonlit-review）或内容引擎（moonlit-content-engine）按需取用。

登录阶段依赖本机已初始化的 ego-browser；本 Skill 不依赖 CreatorOS。登录态最终由本 Skill 维护，默认落在 `~/.moonlit-creator/.auth/douyin/<accountId>/`。

## Agent 执行规则

用户调用本 Skill 时，Agent 必须直接执行脚本，不要让用户复制命令到终端：

1. 先自动运行 `node scripts/src/extract.mjs --account <id> --auth-probe`。
2. 如果返回 `unknown`、`expired`，立即自动运行 `node scripts/src/extract.mjs --account <id> --login-only`。
3. ego-browser 页面出现后，提示用户扫码；不要要求用户手动运行任何命令。
4. 登录成功后，继续自动执行用户请求的采集命令；若用户只要求登录，则在登录成功后结束。
5. 用户明确要求“运行这个 skill”且未指定只检查登录时，默认执行完整采集。

## When to use

- 用户说"把抖音数据落盘"、"按作品抓评论"、"刷一下抖音指标"、"把月明自己的抖音评论拉下来看看"
- 月明第一次用本 Skill，需要先扫码登录一次（详见下方工作流第 1 步）
- 月明复盘 / 选题需要真实的评论样本（不能凭印象写）

不要用本 Skill：

- 抓对标博主 / 黑马雷达 / 收藏夹跟拍（不在范围）
- 抓单条公开视频的公开统计（绕过登录态的方案另议，本 Skill 必须复用登录态）
- 把抓取结果直接当月明自己的作品发布（产出归原始作品，跟月明作品是两套）

## 工作流

1. **首次使用 → 自动扫码登录一次**。Agent 自动执行 `node scripts/src/extract.mjs --account <id> --login-only`，脚本会调用 ego-browser 打开可见的抖音创作者中心页面，引导用户扫码。扫码成功后，会话 Cookie 注入 `~/.moonlit-creator/.auth/douyin/<id>/`，进程退出（退出码 0）。
2. **检查登录态**。运行 `node scripts/src/extract.mjs --account <id> --auth-probe`，输出"已登录/未登录/会话过期"三态之一。可作为 cron 健康检查。
3. **采集**。运行 `node scripts/src/extract.mjs --account <id>`，脚本会：
   - 检查 cookie 存在 + creator/user/info 返回 0；不满足 → 报错要求先扫码
   - 拉所有可见作品指标写到对应作品的 `distribution/douyin/<awemeId>/{meta.json, metrics.json}`
   - 逐作品抓评论写到 `comments.json`
   - 末尾写 `_index.json` 顶层汇总
5. **单作品重采**：`--aweme <id>` 仅重跑某个作品
6. **只刷评论 / 只刷指标**：见 [references/recipes.md](references/recipes.md)
7. **会话过期**：脚本检测到 status_code=8 会立即停，已写文件保留，提示用户重跑 `--login-only` 重扫
8. **如需逐字稿**：转交给 moonlit-video-script 的转写能力（不归本 Skill 管，本 Skill 不调 ffmpeg）

完整字段约定见 [references/data-shape.md](references/data-shape.md)。输出目录与作品命名见 [references/output-layout.md](references/output-layout.md)。登录态与扫码流程见 [references/auth-setup.md](references/auth-setup.md)。常见调用模式见 [references/recipes.md](references/recipes.md)。

## 硬规则

- **不依赖 CreatorOS**：登录阶段使用 ego-browser 的可见页面，采集阶段使用 Skill 自己管理的 Playwright profile，登录态最终落在 `~/.moonlit-creator/.auth/douyin/<accountId>/`。需要本机已完成 ego-browser 安装和初始化。
- **可显式指向 CreatorOS profile**：通过 `--auth-dir ~/CreatorOS/.auth/douyin/<id>` 可以让 Skill 读取 CreatorOS 已扫码的 cookie（**仅在用户明确指定时**才这么做；默认绝不读 CreatorOS 路径）。这一选项的存在是为了让已经用 CreatorOS 扫过码的用户不用再扫一次，但 Skill 自身不假设 CreatorOS 存在。
- **不存原始 cookie**：cookie 仅来自磁盘 profile，不在脚本内下载、上传或打印；日志只输出"已登录/未登录/会话过期"三类状态。
- **不存明文账号身份**：`meta.json` 写 `awemeId`（稳定 ID）+ 抖音 URL，**不写昵称、抖音号、sec_uid**（这些都是 CreatorOS 内部用于替换占位；落盘后属于敏感隐私数据，避免泄漏到 git / 协作渠道）。
- **尊重限流**：每翻一页作品 / 每翻一页评论，间隔 ≥ 4 秒。脚本里硬编码 sleep，不依赖外部调度。
- **评论抓不全要诚实**：`comments.json` 顶部固定字段 `incomplete: bool` + `truncatedReason`；如"撞冷却截断：已采 X/Y 条评论"，禁止静默吞错。
- **不可重复覆盖**：默认同名文件**追加新内容而不覆盖**；`--force` 才允许覆盖（用于单作品重采）。
- **失败不写脏数据**：任一作品任一步骤抛错，对应作品目录要么完整（成功），要么只写 `_FAILED.json` 记录失败原因。**禁止写到一半留半个 metrics.json**。
- **登录态过期要立刻停**：发现 sessionid 失效（`/aweme/v1/creator/user/info/` 返回 status_code=8 或跳登录页），立即停止采集，已写文件保留，并在 run summary 里报"会话过期请重跑 --login-only 重扫"。
- **SingletonLock 安全**：检测到 SingletonLock 文件且进程存活 → 拒绝启动（"另一个程序正在使用此 profile"），不强行清理（避免数据竞争）。

## 交付标准

- 每个目标作品目录下都有：`metrics.json` + `meta.json` + `comments.json`（三件套缺一不可）。
- `metrics.json.metrics` 含 `views/likes/comments/shares/favorites` 五个整数；可空但必须有键。
- `meta.json` 含 `awemeId / title / publishedAt / shareUrl / capturedAt`；可空但必须有键。
- `comments.json` 含 `items: []`；长度可为零（合法 0 评）；`collectedAt` ISO 时间必填。
- 一次完整 run 必须在 stdout 输出：`已完成 N 个作品的指标 +M 个作品的评论 +跳过的原因`，给调用方核对。
- 至少一次真实账号 + 已登录态的运行证据（手动执行一次 `node scripts/src/extract.mjs --account ID --login-only` 的截图或日志）。

## 依赖

- Node.js ≥ 22（用 ESM 原生 + top-level await）。
- 系统已安装并初始化 ego-browser；采集依赖 `playwright` 自带的 Chromium（首次运行 `npm install` 会自动下载）。
- 输出落对应作品目录的 `distribution/douyin/<awemeId>/`；未匹配作品暂存于 `works/douyin/_unassigned/<awemeId>/`（见 [references/output-layout.md](references/output-layout.md)）。
- 登录态默认落 `~/.moonlit-creator/.auth/douyin/accountId/`（也可 `--auth-dir` 指向其他位置）。
- 后续消费方（按需）：moonlit-topic-radar、moonlit-review、moonlit-content-engine。
