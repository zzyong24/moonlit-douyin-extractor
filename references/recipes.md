# 常用调用模式

本 Skill 入口是 `scripts/run.sh`（薄壳）和 `node scripts/src/extract.mjs`（主程序）。下面是从调用方视角的常见模式。

## 前置：确认环境

```bash
# 1. 确认 Node ≥ 22
node --version

# 2. 装依赖（首次）
#    假设你在 Skill 根目录跑（即 SKILL.md 所在目录）；scripts/ 是其子目录
cd scripts
npm install    # 或 pnpm install

# 3. 首次跑：扫码登录
node src/extract.mjs --account _default --login-only
#  → 弹 headed Chromium 窗口 → 扫一下码 → 关窗 → cookie 落 ~/.moonlit-creator/.auth/douyin/_default/

# 4. 健康检查（确认 cookie 可用）
node src/extract.mjs --account _default --auth-probe
#  → stdout: [extract] 登录态: active
```

> 如果你把 Skill clone 到别的目录（不是 moonlit-skills 仓库内的 `skills/moonlit-douyin-extractor/`），所有 `cd scripts` 仍然指向相对位置——本 Skill 不假设任何绝对路径。

## 1. 首次全量采（指标 + 评论）

```bash
node src/extract.mjs --account _default
```

行为：
- 自动检测 cookie 存在 + creator/user/info 返回 0；不满足 → 报错先扫码
- 拉全部可见作品（约 1-3 页，≤ 40 作品）
- 每个作品写 `meta.json` + `metrics.json` + `comments.json`
- 末尾重写 `_index.json`
- stdout 输出：`[done] 已完成 23 个作品的指标 +327 条评论`

预计时长：24 作品 ≈ 2 分钟（评论含翻页限流，4s/页）。

## 2. 只刷指标（不抓评论）

```bash
node src/extract.mjs --account _default --no-comments
```

适合每天跑：评论上一次抓过了，今天先看指标增量。

## 3. 只刷评论（指标上次已抓过）

```bash
node src/extract.mjs --account _default --comments-only
```

适合凌晨跑评论 + 早上看指标。

## 4. 单作品重采

```bash
node src/extract.mjs --account _default --aweme 7523456789012345678 --force
```

`--force` 覆盖已有 `metrics.json` / `comments.json`。无 `--force` 时：
- `meta.json` 始终覆盖（标题/发布时间可能微调）
- `metrics.json` 追加到 `history[]`
- `comments.json` 合并去重

## 5. 续跑失败的

```bash
node src/extract.mjs --account _default --resume
```

只处理 `_FAILED.json` 的作品，未失败的不动。

## 6. 自定义账号 / 登录态路径

```bash
# 多账号：accountId = 'creator-account-2'
node src/extract.mjs --account creator-account-2

# 自定义 profile 路径（默认 ~/.moonlit-creator/.auth/douyin/<account> 下）
node src/extract.mjs --account ID --auth-dir /custom/path/to/profile
```

## 7. 只探针登录态（不开抓）

```bash
node src/extract.mjs --account _default --auth-probe
```

仅启动浏览器读 cookie + 探一次 `/aweme/v1/creator/user/info/`，输出"已登录 / 会话过期 / 未登录"三态之一，立即退出。

适合作为 cron 健康检查：
- 已登录 → 0 退出码
- 会话过期或未登录 → 非 0 退出码 → 触发告警

## 8. 只扫码不抓（首次或重扫）

```bash
# 首次扫码
node src/extract.mjs --account _default --login-only

# 重扫（sessionid 过期后）
node src/extract.mjs --account _default --login-only
# 扫码完成后正常跑：node src/extract.mjs --account _default --resume
```

## 9. 关键作品刷新（手动运营）

```bash
# 给某作品加补充评论
node src/extract.mjs --account _default --aweme 7523456789012345678 --comments-only
```

## 10. 输出验证

```bash
# 总览
cat ~/moonlit-creator/works/douyin/_index.json | jq .

# 单作品
cat ~/moonlit-creator/works/douyin/7523456789012345678/metrics.json | jq .

# 失败作品
ls ~/moonlit-creator/works/douyin/*/_FAILED.json

# 评论样本（看看月明收到的真实评论）
jq '.items[0:3]' ~/moonlit-creator/works/douyin/7523456789012345678/comments.json
```

## 11. 与其他 Skill 串联

```bash
# 萃取 → 选题雷达的输入准备
node src/extract.mjs --account _default
# 接着（Agent 自动接管）：
#   → 读 _index.json 拿到近期作品
#   → 调 moonlit-topic-radar 让月明根据真实数据做本周选题
```

## 故障排查

| 现象 | 排查 |
|---|---|
| `登录态目录不存在` | 先跑 `--login-only` 扫码 |
| `SingletonLock exists & process alive` | 关闭另一个 Chromium 实例（可能是 CreatorOS 或上一次的 Skill 没干净退出） |
| `会话已过期（status_code=8）` | 重跑 `--login-only` 重扫 |
| `评论 incomplete: true` | 限流撞冷却，等 5 分钟再跑 `--resume` |
| `XHR 无响应` | 抖音端点变更（端点常量在 `scripts/src/metrics.mjs` 和 `comments.mjs` 顶部，按需调整） |
| `_index.json` 缺失 | 本次 run 还没成功跑过 |
| `metrics.json.history` 过长 | 定期手动归档（脚本暂不自动裁剪） |