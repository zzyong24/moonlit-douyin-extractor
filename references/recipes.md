# 常用调用

所有账号范围操作都显式使用 `--account <别名>`。别名只用于本机 profile 和数据目录，与抖音昵称无关。

## 首次安装与绑定

```bash
cd scripts
npm install
npx playwright install chromium
node src/extract.mjs --accounts
node src/extract.mjs --account main --login-only
```

扫码成功后会先核验创作者中心身份，再绑定 `main`。如同一抖音身份已绑到别的别名，操作会停止且不创建重复绑定。

## 单账号采集

```bash
# 全量指标和评论
node src/extract.mjs --account main

# 只刷新指标
node src/extract.mjs --account main --no-comments

# 只抓评论
node src/extract.mjs --account main --comments-only

# 单作品重采
node src/extract.mjs --account main --aweme 7523456789012345678 --force

# 只重试上次失败的作品
node src/extract.mjs --account main --resume

# 登录态及稳定身份探针，不采集
node src/extract.mjs --account main --auth-probe
```

重复运行会追加指标历史并按 `commentId` 合并评论。只有明确要求时才使用 `--force` 覆盖单作品已有指标/评论。

## 顺序刷新多个账号

用户明确要求更新所有已绑定账号时：

```bash
node src/extract.mjs --all-accounts
node src/extract.mjs --all-accounts --no-comments
node src/extract.mjs --all-accounts --resume
```

命令按注册表顺序逐个启动独立子进程，每个子进程先核验该别名的 profile 身份，再写入该别名的输出根。一个账号失败后继续处理后续账号，最终以非零退出码和逐账号日志报告失败数。登录、身份绑定、单作品重采和健康探针必须逐账号执行。

## 自定义输出目录

```bash
# 为当前账号指定一个新的空目录
node src/extract.mjs --account main --root /path/to/douyin-data/main

# 批量时将这个目录作为基路径，脚本会在下面追加每个账号别名
node src/extract.mjs --all-accounts --root /path/to/douyin-data
```

每个输出根首次使用时会写 `_account.json` 归属标记。目录已有未标记历史文件时拒绝自动接管；目录已归属其他别名时拒绝写入。为旧数据选择新目录可保留原数据，不会静默迁移或覆盖。

## 查看结果

```bash
# 列出别名
node src/extract.mjs --accounts

# 当前账号索引
cat ~/moonlit-creator/works/douyin/main/_index.json | jq .

# 当前账号未归档作品
ls ~/moonlit-creator/works/douyin/main/_unassigned/

# 浏览失败记录
find ~/moonlit-creator/works/douyin/main -name _FAILED.json -print
```

已映射 Workbase 作品的数据位于 `works/<year>/<work>/distribution/douyin/<别名>/<awemeId>/`。每个别名有自己的索引，即使同一条 Workbase 作品包含不同账号发布的数据也不会共用目录。

## 恢复方式

| 现象 | 处理 |
|---|---|
| 别名未绑定 | 选择该别名并执行 `--account <别名> --login-only` |
| 登录过期 | 重新扫码；随后执行 `--resume` |
| 当前身份与别名不符 | 不采集；确认目标账号后在隔离扫码环境重新绑定该别名 |
| profile 正被使用 | 关闭持有它的 Chromium，再重试；不要删除活锁 |
| 输出目录未标记或归属其他账号 | 选择空的账号专属 `--root`，不要把旧数据强行归到某账号 |
| 评论不完整 | 保留 `incomplete` 与原因；稍后按用户要求恢复 |
| 抖音页面或 XHR 变化 | 停止猜接口结果；核对当前页面和接口响应后再维护脚本 |
