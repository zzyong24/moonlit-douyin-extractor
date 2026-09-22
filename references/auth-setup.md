# 登录态：Skill 自管理 + 引导扫码

本 Skill 的扫码登录阶段调用 **ego-browser** 的可见持久页面，不依赖 CreatorOS。登录成功后，Cookie 会被注入 Skill 自己管理的目录（默认 `~/.moonlit-creator/.auth/douyin/<accountId>/`）。

## 设计目标

| 原则 | 落实 |
|---|---|
| ego 可见登录 | 扫码页面由 ego-browser 管理，避免后台 Playwright 窗口不可见 |
| 用户零成本启动 | 检测不到 cookie 时给清晰报错，提示先跑 `--login-only` |
| 一次扫码长期复用 | cookie + profile 永久落在磁盘 |
| 不主动读 CreatorOS 路径 | 默认永远不读；只有用户显式 `--auth-dir` 才读 |
| SingletonLock 安全 | 检测到锁且进程存活 → 拒绝启动，不强行清理 |

## 默认路径

```
~/.moonlit-creator/.auth/douyin/<accountId>/
```

`<accountId>` 是月明在抖音的多账号标识（默认 `_default`）。脚本默认读 `~/.moonlit-creator/.auth/douyin/_default/`，可用 `--account ID` 切换账号。

为什么放在 `~/.moonlit-creator/` 下：

- 它是 moonlit-creator workspace 的私有数据目录，与 `works/` 同级
- 自然符合"moonlit 体系一切私有数据都在 `~/.moonlit-creator/` 下"的约定
- 升级 / 备份 / 迁移 moonlit-creator workspace 时一并带走

## 首次使用：扫码流程

```bash
node scripts/src/extract.mjs --account _default --login-only
```

执行后脚本会：

1. 调用 ego-browser 的可见持久页面
2. 导航到 `https://creator.douyin.com/creator-micro/home`（创作者中心登录页）
3. 在窗口里显示二维码 + 等待用户扫码
4. 每秒轮询 cookie，出现 `sessionid` 后用 `/aweme/v1/creator/user/info/` 探一次，status_code=0 → 登录成功
5. 通过 CDP 读取 Cookie，注入到 `~/.moonlit-creator/.auth/douyin/_default/`
6. 退出码 0，stdout 输出 `[login] 登录成功 → ~/.moonlit-creator/.auth/douyin/_default/`

扫码超时默认 240 秒；用户随时关窗 = 取消登录（不会报错）。

## 后续采集：自动检测登录态

```bash
node scripts/src/extract.mjs --account _default
```

执行后脚本会：

1. 打开 profile 目录（如果不存在 → 报错"未扫码"，引导用户先跑 `--login-only`）
2. 检测 SingletonLock（如果存在且进程存活 → 报错"另一个进程正在使用此 profile"）
3. 起 headless Chromium，复用磁盘 cookie
4. 探 `/aweme/v1/creator/user/info/`：
   - status_code=0 → 已登录，继续采集
   - status_code=8 → 会话过期，提示用户重跑 `--login-only` 重扫
   - 其他 → 未登录/异常，提示用户重跑 `--login-only`

首次扫码或重扫需要 ego-browser 的可见页面；后续探针和采集不需要 GUI 介入。

## 命令一览

```bash
# 首次扫码登录（一次性）
node scripts/src/extract.mjs --account ID --login-only

# 健康检查（探针登录态，cron 可用）
node scripts/src/extract.mjs --account ID --auth-probe

# 全量采集（指标 + 评论）
node scripts/src/extract.mjs --account ID

# 切换账号 / 自定义路径
node scripts/src/extract.mjs --account creator-account-2
node scripts/src/extract.mjs --account ID --auth-dir /custom/path

# 复用 CreatorOS 已扫码的 cookie（不推荐除非你确定 CreatorOS 不在跑）
node scripts/src/extract.mjs --account ID --auth-dir ~/CreatorOS/.auth/douyin/ID
```

## SingletonLock 冲突规避

**Playwright 的 Chromium 用 SingletonLock 防止两个进程同时打开同一 profile**。如果另一个 Chromium 实例正在用，本 Skill 启动时 `launchPersistentContext` 会直接报错。规避策略：

| 状态 | 处理 |
|---|---|
| `.auth/.../SingletonLock` **不存在** | 安全启动 |
| `.auth/.../SingletonLock` **存在但进程已死** | 自动清锁后启动（异常退出遗留） |
| `.auth/.../SingletonLock` **存在且进程存活** | 拒绝启动，提示"另一个进程正在使用此 profile" |

绝对不强行覆盖 SingletonLock —— 这会丢数据。

## 与 CreatorOS 共享 cookie（可选，不推荐）

如果用户**已经用 CreatorOS 扫过码**，不想再扫一次，可以显式指向 CreatorOS 的 profile：

```bash
node scripts/src/extract.mjs --account ID --auth-dir ~/CreatorOS/.auth/douyin/ID
```

**注意**：

- 这是 Skill 的"逃生口"而非默认行为。**默认绝不读 CreatorOS 路径**。
- CreatorOS 正在运行时同时启动本 Skill → SingletonLock 冲突，本 Skill 拒绝启动
- CreatorOS profile 内部文件结构与 Skill 完全兼容（都是 Playwright `launchPersistentContext` 的标准布局）
- 如果用户希望两者彻底独立 → 不要用这个选项，分别扫码即可

## sessionid 过期怎么办

不要试图在本 Skill 里换 cookie 或重新生成二维码。直接报错回退给用户：

```
✗ 会话已过期（status_code=8）
  已成功写入 18/23 作品；剩余 5 个作品标记 _FAILED.json。
  请重跑以下命令重新扫码：
    node scripts/src/extract.mjs --account ID --login-only
  扫码完成后用 --resume 重试失败的：
    node scripts/src/extract.mjs --account ID --resume
```

`--resume` 标志：仅处理 `_FAILED.json` 的作品，未失败的作品不动。

## 隐私边界

- Cookie 文件本身**不进 git**（用户应在 `~/.moonlit-creator/.gitignore` 忽略 `.auth/`）
- 本 Skill 不读 cookie 内容，不打印 cookie
- 日志最多输出"已登录" / "未登录" / "会话过期" 三态
- meta.json 不写 `nickname` / `sec_uid` / `unique_id`（见 output-layout.md 的"硬规则"）
