# scripts/

`moonlit-douyin-extractor` 的独立抓取脚本。登录阶段调用 ego-browser 的可见页面扫码，采集阶段独立复用 Playwright profile，不依赖 CreatorOS。

## 安装

```bash
cd scripts
npm install    # 或 pnpm install
```

只需装一次（会自动下载 playwright 自带的 Chromium）。后续直接 `node src/extract.mjs` 即可。

## 首次使用：先扫码一次

```bash
node src/extract.mjs --account _default --login-only
# ego-browser 可见页面 → 扫一下码 → cookie 注入 ~/.moonlit-creator/.auth/douyin/_default/
```

之后正常调用：

```bash
# 全量（指标 + 评论）
node src/extract.mjs --account _default

# 只刷指标
node src/extract.mjs --account _default --no-comments

# 只刷评论
node src/extract.mjs --account _default --comments-only

# 单作品
node src/extract.mjs --account _default --aweme <id> --force

# 仅登录态探针（cron 健康检查）
node src/extract.mjs --account _default --auth-probe
```

更详细见 [`../references/recipes.md`](../references/recipes.md)。

## 文件结构

```
scripts/
├── README.md                    ← 本文件
├── package.json
├── run.sh                       ← 薄壳（自动 npm install + 转发参数）
└── src/
    ├── extract.mjs              ← 主入口 / CLI 参数解析 / 流程编排
    ├── browser.mjs              ← Playwright launchPersistentContext + loginDouyinProfile（扫码）+ 登录态探针
    ├── metrics.mjs              ← 抓作品指标（work_list XHR 拦截 + parseWorkList）
    ├── comments.mjs             ← 抓评论（comment/list XHR 拦截 + parseCommentList）
    ├── parsers.mjs              ← 纯函数（parseWorkList / parseCommentList / deriveTitle）
    └── layout.mjs               ← 落盘布局：meta.json / metrics.json / comments.json / _index.json
```

## 设计约束

1. **Self-contained，不依赖 CreatorOS**。所有代码 standalone Node ESM（不需要 tsx / transpile / monorepo）。
2. **Cookie 仅从 `--auth-dir` 指定目录读**，默认 `~/.moonlit-creator/.auth/douyin/<accountId>`。不下载、不上传、不打印。
3. **每翻一页 sleep ≥ 4s**，不依赖外部限流器。
4. **失败不写半截文件**。任一作品任一阶段抛错 → 该作品只写 `_FAILED.json`，已写完的不动。
5. **重复跑不丢历史**。`metrics.json.history[]` 追加；`comments.items` 按 commentId 合并。

## 调试

```bash
DEBUG=1 node src/extract.mjs --account _default --no-comments   # 启用 console.log 调试输出
```

设 `MOONLIT_DOUYIN_NO_COLOR=1` 关闭 ANSI 颜色。
