# RSS 订阅源仓库（GitHub Actions + Folo）

这个仓库用 **GitHub Actions 每天自动**生成多个 RSS 源并提交回仓库，
你只需要把仓库里 XML 的**公开地址**丢给 Folo 之类的云端阅读器即可长期订阅。
（云端阅读器由它自己的服务器抓取，所以必须是公网地址，本机 `127.0.0.1` 不行。）

目前包含两个源：

| 订阅源 | 生成脚本 | 数据来源 |
| --- | --- | --- |
| `manhuagui-all.xml` / `manhuagui-<id>.xml` | `manhuagui-rss.mjs` | 看漫画各漫画的章节列表 |
| `govcn-feed.xml` | `govcn-rss.mjs` | 中国政府网「最新政策」栏目的 JSON 数据源 |

## 仓库内容

| 文件 | 说明 |
| --- | --- |
| `manhuagui-rss.mjs` | 漫画章节 RSS 生成脚本（零依赖，Node ≥ 18） |
| `feeds.json` | 你要追的漫画列表与生成选项 |
| `govcn-rss.mjs` | 中国政府网「最新政策」RSS 生成脚本 |
| `demo-image-feed.mjs` | 图片显示测试源（验证阅读器能否显示 feed 里的图片） |
| `.github/workflows/rss.yml` | 每天定时跑全部脚本、校验 XML、把结果提交回仓库 |
| `manhuagui-<id>.xml` | 每部漫画各自的订阅源（首次运行后生成） |
| `manhuagui-all.xml` | 所有漫画合并成一个订阅源（推荐订这个） |
| `govcn-feed.xml` | 中国政府网最新政策订阅源（最近 100 条，其中前 20 条带**公文正文全文**与发文机关/发文字号/主题分类） |
| `.govcn-content-cache.json` | 公文正文缓存，提交它可以避免每天重复抓取 |
| `.feed-state.json` | 状态文件，**必须提交**，用于稳定 `pubDate` |

## 最快的方式：桌面一键更新

已经在本机桌面放了快捷方式 **`更新RSS到GitHub.lnk`**，它指向 `rss-repo\一键更新到GitHub.cmd`。

- **首次双击**：提示输入 GitHub 用户名和仓库名（需先在 <https://github.com/new> 建好 Public 仓库）→ 自动 `git init`、生成订阅文件、提交、推送；第一次推送会弹出浏览器要求登录 GitHub，登录一次即可
- **以后每次双击**：重新生成两个订阅源 → 自动提交 → 推送到 GitHub，全程无需输入
- 结束时窗口会打印可以直接粘贴到 Folo 的 jsDelivr 订阅地址

脚本细节：提交身份默认用 `<你的GitHub用户名>@users.noreply.github.com`（只写入仓库本地配置，不影响全局）；中国政府网内容没变化时不会产生多余提交；漫画源被站点限流时会跳过并继续推送另一个源。

## 你需要做的 5 步（手动方式，一键脚本已覆盖）

### 1. 建一个公开仓库

在 GitHub 上新建仓库（**必须是 Public**，私有仓库的 jsDelivr / Pages 取不到文件），名字随意，比如 `manhuagui-rss`。

### 2. 把这些文件推上去

在本文件夹（`rss-repo`）里打开终端：

```powershell
git init
git add -A
git commit -m "init: RSS 订阅源"
git branch -M main
git remote add origin https://github.com/<你的用户名>/manhuagui-rss.git
git push -u origin main
```

不想用命令行的话，也可以在仓库页面点 **Add file → Upload files**，把这些文件（含 `.github/workflows/rss.yml`）拖进去。

### 3. 手动跑一次工作流

仓库页面 → **Actions** → 左侧「更新漫画 RSS」→ 右侧 **Run workflow**。

跑完仓库里会出现 `manhuagui-45638.xml`、`manhuagui-all.xml` 和 `.feed-state.json`。

### 4. 拿到公开订阅地址（任选一种）

| 方式 | 地址 | 特点 |
| --- | --- | --- |
| **jsDelivr（推荐）** | `https://cdn.jsdelivr.net/gh/<用户名>/manhuagui-rss@main/manhuagui-45638.xml` | 国内可直连；分支缓存约 12 小时 |
| GitHub Pages | `https://<用户名>.github.io/manhuagui-rss/manhuagui-45638.xml` | 需先在 Settings → Pages 里选 “Deploy from a branch / main / (root)”；缓存约 10 分钟 |
| GitHub Raw | `https://raw.githubusercontent.com/<用户名>/manhuagui-rss/main/manhuagui-45638.xml` | 更新最快，但国内网络经常连不上 |

想看全部漫画就用 `manhuagui-all.xml` 那个地址。
中国政府网最新政策则是把文件名换成 **`govcn-feed.xml`**，例如：
`https://cdn.jsdelivr.net/gh/<用户名>/manhuagui-rss@main/govcn-feed.xml`

### 5. 在 Folo 里订阅

Folo → **添加订阅 / Add feed** → 粘贴上面的地址 → 完成。Folo 会按它自己的节奏来拉取，本站每天更新一次。

## 想再追别的漫画

编辑 `feeds.json`：

```json
{
  "comics": ["45638", "107", "60387"],
  "outdir": ".",
  "limit": 100,
  "combined": true,
  "state": ".feed-state.json"
}
```

漫画 ID 就是漫画页地址里的数字，例如 `https://www.manhuagui.com/comic/107/` → `"107"`。
改完 push，再到 Actions 点一次 Run workflow 即可（之后每天自动跑）。

其他可调项：`limit`（每个源最多多少条，`0` = 全部）、`withIntro`（item 里附带内容简介）、`withCover`（item 里嵌入封面图，阅读器会显示缩略图）、`newOnly`（只输出新章节）、`timeout`（单次请求超时秒数）。

可选项：等你确定了自己的托管地址后，把 `"self": "https://cdn.jsdelivr.net/gh/<用户名>/manhuagui-rss@main/manhuagui-all.xml"` 写进 `feeds.json`，这样 feed 里的 `atom:link rel="self"` 会指向它自己（部分阅读器会用它做校验）。

## 更新节奏与缓存

- 工作流默认 **每天 UTC 04:17（北京时间 12:17）** 跑一次，改 `.github/workflows/rss.yml` 里的 `cron` 可调整。
- GitHub 会在仓库 60 天没有任何提交后暂停定时任务；本工作流每天都会提交，一般不受影响。
- 阅读器看到新章节的时间 ≈ 工作流运行时间 + 托管平台缓存（jsDelivr 最长约 12 小时，Pages 约 10 分钟）。想更快就用 Pages 或 Raw。

## 如果 Actions 上抓不到数据

GitHub 的机器在海外，可能遇到 manhuagui 的超时或 `HTTP 403` 风控。工作流已内置「失败等 5 分钟重试，共 3 次」，仍失败时**保留上一次的 XML 不删**，不会污染订阅。

持续失败的话，改成「本机生成 + 推送」：

```powershell
node manhuagui-rss.mjs --config feeds.json
git add -A
git commit -m "chore: 更新 RSS"
git push
```

配一个 Windows 计划任务让它每天自动做（在本文件夹执行一次）：

```powershell
$dir = (Get-Location).Path
schtasks /Create /TN "manhuagui-rss-push" /SC DAILY /ST 12:30 /F /TR "cmd /c cd /d `"$dir`" && node manhuagui-rss.mjs --config feeds.json && git add -A && git commit -m auto && git push"
```

## 顺带一提

- 生成的 feed 里只有漫画名、章节名、页数和章节链接，**不包含任何漫画图片**，也没有绕过站点的付费/权限限制。
- 请遵守站点条款与版权要求，把它当成个人追更提醒使用，不要二次分发漫画内容。
- 本机还想用本地阅读器看的话，上一层的 `生成RSS.cmd` / `启动RSS服务.cmd` 依然可用。
