![抖音数据萃取：让作品指标与评论，成为复盘材料](assets/readme/hero.png)

# 月明·抖音萃取

一个独立的多账号抖音创作者数据萃取 Skill 和 Node.js 工具。通过创作者中心扫码绑定自己管理的账号，按本机别名隔离登录态、作品数据、指标、评论和索引。

本项目不调用 CreatorOS CLI 或内部服务，也不读取 CreatorOS 数据库、账号目录和浏览器登录态。

## 能力

- 使用新的临时 Playwright profile 扫码；读到稳定身份后才绑定本机别名。
- 按账号保存登录 profile 和数据目录；采集前复核当前身份。
- 读取自己的已发布作品信息、播放/点赞/评论/分享/收藏指标及评论。
- 用稳定作品 ID 关联本机已有作品；无法唯一关联时放入该账号自己的 `_unassigned/`。
- 每次采集保留指标历史，按评论 ID 合并；缺字段不编造，失败记录原因。

## 快速开始

需要 Node.js 22+、支持本机浏览器窗口的桌面环境和用户自己的抖音创作者账号。可将完整仓库目录安装为本地 Skill，或直接运行随仓库提供的脚本。

```bash
cd scripts
npm install
npx playwright install chromium

# 扫码绑定账号别名
node src/extract.mjs --account studio-a --login-only

# 查看已绑定别名
node src/extract.mjs --accounts

# 采集一个账号，或顺序采集全部已绑定账号
node src/extract.mjs --account studio-a
node src/extract.mjs --all-accounts
```

可用 Skill 的 Agent 也可以这样请求安装：

```text
请安装这个 Skill：https://github.com/zzyong24/moonlit-douyin-extractor
```

## 本机数据与隐私

- 登录态默认保存在 `~/.moonlit-creator/.auth/douyin/<accountId>/`。
- 账号注册表只保存稳定身份的 SHA-256 指纹，不保存原始 `sec_uid`；作品数据默认保存在 `~/moonlit-creator/works/douyin/<accountId>/`。
- 不要把登录目录、账号注册表或采集结果提交到仓库、云盘或工单。仓库 `.gitignore` 会排除常见凭据与运行产物。
- 输出目录有归属标记。未标记的旧数据不会被自动认领；同一路径已属于其他账号时会拒绝写入。
- 只采集用户自己有权访问的账号数据。登录、权限和页面接口受抖音平台控制；页面变化或登录身份不匹配时应停止处理。

抖音创作者页面与接口可能变化。单元测试不代表已通过真实账号登录或平台端到端验收；请在自己的账号和本机环境验证后使用。

## 文档与校验

- [Skill 使用规则](SKILL.md)
- [账号绑定与登录隔离](references/auth-setup.md)
- [常用命令](references/recipes.md)
- [输出目录与 JSON 结构](references/output-layout.md)
- [字段来源](references/data-shape.md)
- [独立脚本说明](scripts/README.md)

```bash
cd scripts
npm test
```

## 许可证

本项目代码与文档按 [MIT License](LICENSE) 发布。抖音平台、接口和其返回内容仍受平台规则约束。

首图是 AI 生成的品牌概念插画，不是实际产品界面或运行结果。
