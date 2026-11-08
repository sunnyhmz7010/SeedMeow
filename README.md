<div align="center">
  <h1>SeedMeow</h1>
  <p>自动监控论坛新帖，筛选后推送到 MeoW</p>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" />
</p>

<p align="center">
  <a href="./package.json"><img src="https://img.shields.io/badge/version-1.0.0-3b82f6" alt="Version 1.0.0" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-10b981" alt="License" /></a>
</p>

---

## ✨ 为什么做这个项目

NodeSeek 和烧饼论坛上的优惠与补货信息更新很快。SeedMeow 在一个容器中订阅两站的官方订阅源，各自使用独立的昵称、关键词、版块过滤和轮询间隔，将命中的帖子推送到 MeoW。

- 一个容器同时监控两个论坛，也可以只启用其中一个。
- 两站分别设置关注规则，避免某站的屏蔽词或版块设置影响另一站。

## 🚀 核心能力

- 官方订阅直连：使用 NodeSeek RSS 与烧饼 Atom，无需论坛账号、Cookie 或浏览器。
- 独立筛选：关键词、组合词、正则和版块匹配支持叠加，另有版块过滤、屏蔽词和标题/摘要范围选择。
- 独立运行：每站使用自己的轮询任务与错误计数，一站请求失败不会阻塞另一站。
- 独立去重与补推：按来源保存最近处理的帖子和待重试消息，容器重建后可通过命名卷继续使用。
- 来源明确：按论坛显示 MeoW 来源名称、图标和中文版块，日志包含来源名称。
- 自检与更新提示：每站可设置自检间隔，并检查 SeedMeow 更新。

## ⚡ 快速开始

### 📋 前置要求

- Docker Engine 和 Docker Compose。
- 能访问 `https://rss.nodeseek.com/`、`https://sb.sb/atom.xml` 和 `https://api.chuckfang.com` 的网络。
- 一个或两个 MeoW 昵称；两站可以填写同一个昵称。

### 📦 安装与运行

#### 🐳 Docker Compose

1. 解压源码包，进入包含 `compose.yaml` 的目录。当前交付为源码，默认从本地构建镜像。
2. 复制配置示例，并将两个 `MEOW_NICKNAME` 的值改成你的实际 MeoW 昵称：

```bash
cp .env.example .env
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env
```

3. 启动并查看日志：

```bash
docker compose up -d --build
docker compose logs -f
```

正常情况下会分别收到两站的 SeedMeow 启动通知。日志出现各来源的“监控已启动”和“首次扫描建立基线”后，会开始关注后续新帖。MeoW 启动测试失败会记录错误并继续监控；配置错误或损坏的状态文件会导致启动失败。

容器不监听端口，不需要端口映射。Compose 自动创建 `seedmeow-data` 命名卷并挂载至 `/app/data`。

## 📖 使用说明

### 📋 独立配置

只有 `SOURCES` 为全局变量，默认 `nodeseek,sb`。设为 `nodeseek` 或 `sb` 可仅启用一个来源；停用来源的配置不会校验。

其余配置必须分别带 `NODESEEK_` 或 `SB_` 前缀。例如 `NODESEEK_KEYWORDS=VPS`、`SB_KEYWORDS=补货`。两站配置独立。

下表使用变量后缀；填写到 `.env` 时务必加上对应前缀。

| 后缀 | 默认值 | 说明 |
| --- | --- | --- |
| `MEOW_NICKNAME` | 必填 | MeoW 昵称，不能包含 `/` |
| `CHECK_INTERVAL_SECONDS` | NodeSeek `5`；烧饼 `60` | 轮询秒数，整数 1–2147483 |
| `CATEGORIES` | `all` | 所有规则的版块过滤；多个标识用英文逗号分隔 |
| `MATCH_SCOPE` | `all` | `title`、`summary` 或 `all`；屏蔽词也在所选范围内匹配 |
| `KEYWORDS` | 空 | 英文逗号分隔；命中任一关键词 |
| `KEYWORD_GROUPS` | `[]` | JSON 二维数组；组内全部命中，组间任一命中 |
| `REGEX_PATTERNS` | `[]` | JSON 字符串数组；使用 `iu` 标志，任一正则命中 |
| `PUSH_CATEGORY` | 空 | `all` 或逗号分隔的版块标识；命中版块直接构成正向规则 |
| `BLOCK_KEYWORDS` | 空 | 英文逗号分隔；命中任一词则拒绝推送 |
| `PUSH_EXISTING` | `false` | 首次成功扫描是否推送已有命中帖 |
| `SHOW_LINK_URL` | `false` | 是否在正文底部附上可复制的链接 |
| `HEALTH_CHECK_MINUTES` | `1440` | 自检分钟数，整数 0–1440；0 关闭定期自检 |

每个已启用来源的 `KEYWORDS`、`KEYWORD_GROUPS`、`REGEX_PATTERNS`、`PUSH_CATEGORY` 至少填写一种。它们之间为“或”关系；版块过滤和屏蔽词可以否决所有正向规则。

JSON 示例：

```dotenv
NODESEEK_KEYWORD_GROUPS=[["香港","VPS"],["日本","线路"]]
SB_REGEX_PATTERNS=["年付\\s*\\d+"]
```

### 🗂️ 版块标识

| 来源 | 可用标识 |
| --- | --- |
| NodeSeek | `daily` 日常、`tech` 技术、`info` 情报、`review` 测评、`trade` 交易、`carpool` 拼车、`promo` 推广、`life` 生活、`dev` Dev、`photo-share` 贴图、`expose` 曝光、`inner` 内版、`sandbox` 沙盒 |
| 烧饼 | `general` 综合、`ai` AI、`domains` 域名、`hosting` 主机、`hardware` 硬件、`trade` 交易、`promotion` 推广、`discounts` 优惠、`share` 分享、`tech` 技术、`jobs` 工作、`invest` 投资、`announcement` 公告 |

版块标识分别校验，例如 NodeSeek 不接受 `hosting`，烧饼不接受 `daily`。

### 💾 运行与状态

首次成功扫描默认将当时全部条目记为基线，不推送已有帖子。需要推送首次扫描中的命中帖时，单独设置对应来源的 `PUSH_EXISTING=true`。

后续修改 `.env` 后运行：

```bash
docker compose up -d
```

普通 `docker compose down` 会保留命名卷；`docker compose down -v` 会删除该卷及其中的去重、待重试状态。

## 🧠 功能细节

- 两种解析器输出统一的帖子字段，分别解析 RSS 与 Atom 并清洗摘要。
- 状态分别保存为 `/app/data/nodeseek/state.json`、`/app/data/sb/state.json`；每站最多保存 1000 个已处理 ID 和 1000 条待重试消息。
- 同一帖子 ID 可以在两站各处理一次。状态使用临时文件及重命名保存；读取、格式或写入错误会明确报错并退出。
- 首次成功扫描建立各自基线；请求失败不会建立基线或推进去重状态。
- 推送失败的帖子进入对应来源的待重试队列，在该来源后续成功轮询时重试，重启后仍可补推。MeoW 明确返回敏感词 403 时，丢弃该帖并标记已处理。
- 启动和自检通知失败只记录日志，不加入帖子补推队列；不影响后续帖子监控。连续两次订阅源异常会尝试通知，恢复后尝试发送恢复通知。
- 自检任务按来源执行，同一来源的自检不会重叠；更新检查失败会记录警告，不宣称已经是最新版。
- 收到 `SIGTERM` 或 `SIGINT` 后停止两站调度，等待当前推送、状态保存和已开始的自检完成，再退出；Compose 预留 60 秒退出时间。

## 🧱 技术栈

- Node.js 24+：ESM、原生 `fetch`、`node --test` 和任务调度。
- `@xmldom/xmldom` 0.9.10：RSS、Atom 与 HTML 摘要解析。
- Docker：`node:24-alpine` 镜像，以非 root 用户运行。

## 🗂️ 项目结构

```text
SeedMeow/
├── src/
│   ├── sources/       # 两站解析器、来源元数据
│   ├── index.js       # 双来源编排、信号处理和自检
│   ├── config.js      # 按来源解析和校验配置
│   ├── matcher.js     # 共用匹配逻辑
│   ├── meow.js        # 按来源格式化及推送
│   ├── monitor.js     # 独立轮询、去重及补推
│   └── state.js       # 状态持久化
├── test/              # 离线回归测试
├── .env.example       # 双来源完整配置示例
├── compose.yaml       # 本地构建和命名卷
└── Dockerfile
```

## 👨‍💻 本地开发

### 🧰 环境

- 开发平台：Windows、Linux 或 macOS。
- Node.js：24 或更高版本，npm。
- 测试使用模拟订阅源和模拟 MeoW 响应，不发送真实通知。

### ⚙️ 命令

```bash
npm ci
npm test
```

本地直接运行时，将 `.env.example` 复制为 `.env` 并修改昵称，再执行：

```bash
node --env-file=.env src/index.js
```

状态写入当前工作目录的 `data/nodeseek/` 和 `data/sb/`。

## 🔐 安全报告

如果发现安全问题，请不要公开披露细节。请优先参考仓库中的 [SECURITY.md](./SECURITY.md) 提交安全报告。

## 📄 许可证

本项目基于 [GPL-3.0](./LICENSE) 开源。

<div align="center">
  <sub>Built with ❤️ by Sunny</sub>
</div>
