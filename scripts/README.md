# 抖音创作者数据萃取脚本

这是一个独立的 Node.js 命令行工具，演示如何安全地绑定多个抖音创作者账号，并按账号采集和保存自己的作品数据。它不依赖 CreatorOS、ego-browser 或任何 CreatorOS 私有目录结构。

## 安装

```bash
cd scripts
npm install
npx playwright install chromium
```

需要 Node.js 22 或更新版本。Chromium 用于打开创作者中心页面和扫码登录。

## 绑定账号

给账号指定本机别名。每次绑定都会打开新的临时浏览器环境，确认创作者身份后，才把该登录态归档到这个别名下：

```bash
node src/extract.mjs --account studio-a --login-only
node src/extract.mjs --accounts
```

别名只是本地标签。绑定表只存稳定身份标识的 SHA-256 指纹，不存原始 `sec_uid`。登录态保存在 `~/.moonlit-creator/.auth/douyin/<accountId>/`，权限限于当前用户。请勿共享或上传此目录。

## 采集

```bash
# 指定账号采集作品指标和评论
node src/extract.mjs --account studio-a

# 只采集指标，或只采集评论
node src/extract.mjs --account studio-a --no-comments
node src/extract.mjs --account studio-a --comments-only

# 检查登录态；或重采单个作品
node src/extract.mjs --account studio-a --auth-probe
node src/extract.mjs --account studio-a --aweme <作品ID> --force

# 逐账号执行全部已绑定账号
node src/extract.mjs --all-accounts
```

默认结果按别名写入 `~/moonlit-creator/works/douyin/<accountId>/`。自定义 `--root` 会在其下再建立账号子目录。每个结果根有归属标记；如果路径已有未标记的数据，工具会停止并要求用户自行确认迁移，避免静默混写。

## 隔离规则

- 每个账号使用独立登录目录，采集前再次读取当前身份并与绑定指纹比对。
- 一个平台身份不能重复绑定到两个本地别名；别名绑定到另一身份时需要显式迁移处理。
- 作品数据按账号目录组织；映射到项目作品时只用稳定作品 ID，不靠标题猜测。
- 已有关联作品也写入账号专属目录，索引、指标、评论和失败记录都带账号归属。
- 扫码、身份读取、账号登记、归档任一环节失败时会回滚临时登录状态；不会把登录态上传到网络。

抖音页面和接口可能变化，数据范围受当前账号权限与创作者中心展示影响。脚本遇到身份不匹配、权限不足或页面结构不兼容时应停止并提示，不猜身份或补造数据。

更多参数与输出格式见 [`../references/recipes.md`](../references/recipes.md) 和 [`../references/output-layout.md`](../references/output-layout.md)。

运行本目录的回归检查：

```bash
npm test
```
