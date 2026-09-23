# 认证与账号别名

本 Skill 直接用 Playwright 打开**空白临时 profile**做可见扫码登录。它不依赖 CreatorOS 或 ego-browser，不拷贝 Cookie，也不从别的软件复用浏览器目录。

## 环境准备

```bash
node --version                 # 需要 Node.js 22+
cd scripts
npm install
npx playwright install chromium
```

Playwright 会启动本机可见 Chromium；扫码由用户本人在创作者中心页面完成。扫码窗口超时或用户关闭窗口时，临时 profile 会被清理，不改变已有绑定。

## 列出账号

```bash
node scripts/src/extract.mjs --accounts
```

输出仅包含本机别名和绑定时间，不返回 Cookie、原始 `sec_uid` 或会话内容。账号注册表位于 `~/.moonlit-creator/.auth/douyin/accounts.json`。

## 绑定新账号

用户先选择一个未使用的本机别名，例如 `studio-b`：

```bash
node scripts/src/extract.mjs --account studio-b --login-only
```

流程：

1. 创建独立临时 profile 并打开创作者中心二维码。
2. 等待抖音服务端确认登录，再读取创作者账号资料。
3. 必须读取到昵称和稳定 `sec_uid`，否则不创建绑定。
4. 对 `sec_uid` 计算 SHA-256 指纹，拒绝同一身份绑定到多个别名。
5. 只有身份检查通过后，才将 profile 原子归入 `~/.moonlit-creator/.auth/douyin/studio-b/` 并写入注册表。

原始 `sec_uid` 不写入注册表、指标文件或日志。成功提示只显示用户选定别名和昵称。

## 重连已绑定账号

对当前别名重新扫码仍使用同一命令。扫码结果必须与已登记的身份指纹相同；如果扫成了另一个账号，临时 profile 会丢弃，旧 profile 和旧映射保持原样。要新绑定另一个账号，应使用新别名。

旧版本 profile 若没有注册表记录，会保留为 `.legacy-*` 备份；新会话通过独立扫码和身份核验后才接管别名。脚本不会把未核验的 Cookie 直接认作目标账号。

## 登录探针与采集

```bash
node scripts/src/extract.mjs --account studio-b --auth-probe
node scripts/src/extract.mjs --account studio-b
```

每次采集都会核对 profile 中当前账号的稳定身份指纹。失效会话需要重新扫码；身份不符时不采集、不写数据。活跃的 `SingletonLock` 表示 profile 正被占用，脚本会拒绝并发启动，不强制删除。

## 私有数据

默认目录为：

```text
~/.moonlit-creator/.auth/douyin/accounts.json
~/.moonlit-creator/.auth/douyin/<别名>/
```

这些目录保存本机账号绑定和登录会话，不要放入仓库、同步盘或工单，不要把 Cookie 内容贴到聊天里。`--auth-dir` 只用于显式指定某个别名的独立 profile，不能指向 CreatorOS 或另一个别名的 profile。
