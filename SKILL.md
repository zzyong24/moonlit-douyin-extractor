---
name: moonlit-douyin-extractor
description: Use when someone wants to bind their own Douyin creator accounts, collect published-work metrics and comments, or run a verified sequential refresh across multiple accounts. This standalone Skill uses its own Playwright profiles and per-account JSON output; it does not depend on CreatorOS.
metadata:
  display_name: 月明·抖音萃取
  icon: icon.svg
  updated: "2026-09-23"
---

# 🌙 月明·抖音萃取

给自己管理的抖音创作者账号扫码绑定，再把已发布作品的指标和评论按账号、作品保存到本地。账号绑定、登录状态和采集数据各自有明确归属；切换账号不会共用登录目录、索引或未归档数据。

本 Skill 完全独立于 CreatorOS：用随包脚本和 Playwright 打开创作者中心，不调用 CreatorOS CLI、不读取 CreatorOS 的数据库或登录目录。运行结果是按账号隔离的 JSON 文件，不会写回 CreatorOS。

## 适用任务

- 首次绑定自己的抖音创作者账号，或为已有别名重新扫码登录。
- 更新某个账号的作品指标和评论，或续跑失败作品。
- 明确要求“更新所有已绑定账号”时，依次采集每个账号并汇总结果。

不用于采集他人作品、热点、收藏夹、发布内容或自动创建定时任务。用户只问原理或要求写文章时，解释实现即可，不登录、不采集。

## Agent 执行规则

1. 先直接运行 `node scripts/src/extract.mjs --accounts` 查看本机已绑定的别名。运行依赖缺失时进入 `scripts/` 安装依赖；不要让用户复制命令。
2. 用户提到一个账号时，用列表确认唯一别名；未绑定的新账号先由用户指定别名。用户说“全部账号”时才使用 `--all-accounts`。
3. 新绑定或重连运行 `node scripts/src/extract.mjs --account <别名> --login-only`。脚本会打开全新的临时浏览器 profile；提示用户在该窗口扫码。只有服务器确认登录并读到稳定账号身份后，别名绑定和登录目录才会更新。
4. 对已绑定账号采集前运行 `--auth-probe`。若会话过期或身份指纹与该别名不符，停止采集并引导在独立临时环境重新扫码；不能把数据写到别名不匹配的目录。
5. 用户明确要采集时，运行 `node scripts/src/extract.mjs --account <别名>`；只看指标加 `--no-comments`，续跑失败项加 `--resume`。报告实际采集结果和不完整原因，不把排队、超时或缺字段说成成功。

## 账号绑定与数据隔离

- 用户为每个账号指定本机别名，例如 `main`、`shop-b`。别名经过路径校验，不允许路径穿越。
- 每次绑定都在独立的临时 Playwright profile 扫码，不复用另一个账号的浏览器会话。扫码后优先读账号资料响应；若资料接口没有身份，再从本人作品列表的作者字段回退读取。必须同时读到昵称和稳定 `sec_uid`。
- 注册表只保存 `sec_uid` 的 SHA-256 指纹，不保存 Cookie 或原始 `sec_uid`。一个稳定身份不能绑定到两个别名；已绑定别名只能由同一身份更新登录态。
- 每个别名分别保存登录 profile、采集索引和作品数据。输出目录有账号归属标记；即使用户把两个别名误指向同一自定义目录，第二个账号也会被拒绝写入。
- 作品目录按稳定抖音作品 ID 匹配，不按标题猜归属。已知 Workbase 作品会落在其 `distribution/douyin/<别名>/` 子目录；无法唯一匹配时留在当前账号的 `_unassigned/`。
- 旧版本未带账号归属标记的数据不会自动搬动、覆盖或认领。首次遇到旧目录时保留原状，并要求使用新的账号专属输出目录。

## 采集和恢复

作品列表读取指标与作品元数据；评论采集按作品执行。所有数值来自平台当前返回，缺失字段保留空/缺，不伪造为真实的 0。重复采集追加指标历史、按评论 ID 合并评论；单作品重采需用户明确要求覆盖。

会话过期时立即停止后续请求，已完成作品保留，失败作品记录原因。重新扫码后通过 `--resume` 只重跑标记失败的作品。Profile 被另一个 Chromium 进程占用时拒绝并发打开，不强删活锁。

## 依赖与数据位置

- Node.js 22+、Playwright 和 Playwright Chromium。按 [认证与账号说明](references/auth-setup.md) 首次安装；扫码使用 Playwright 打开的本机可见窗口。
- 登录目录与账号注册表默认在 `~/.moonlit-creator/.auth/douyin/`；注册表保存在 `accounts.json`，profile 按别名分目录。
- 每账号默认输出到 `~/moonlit-creator/works/douyin/<别名>/`，包含自己的 `_index.json`、运行记录和未匹配作品。已映射的 Workbase 作品在其作品目录中增加别名子目录。
- Cookie、身份指纹、评论和指标都可能属于敏感数据；这些是运行期本机数据，不属于 Skill 或开源仓库。

命令参数与例子见 [常用调用](references/recipes.md)，字段和文件布局见 [输出结构](references/output-layout.md)。
