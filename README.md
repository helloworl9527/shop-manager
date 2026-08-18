# 店铺商品管理系统 — 后端（M1 地基）

本地化重构自 PriceAI 的采集与分类逻辑。SQLite 存储、前后端分离。本目录是后端，M1 完成的是地基部分。

## M1 已实现

- `server/db/schema.sql` — 6 张表（含 `effective_canonical_product_id` / `search_group_id` 生成列、`availability_rank`、收藏与任务的部分唯一索引）。
- `server/db/connection.ts` — 唯一建连入口 `openDatabase()`，**每个连接**都启用 `foreign_keys` / WAL / `busy_timeout` / `synchronous`。
- `server/db/init.ts` — 建表 + 把分类目录写入 `canonical_products`。
- `server/catalog/catalog.ts` — 从 PriceAI 移植的标准品目录与 `classifyOffer`（ChatGPT/Claude/Gemini… 分类）。
- `server/core/availability.ts` — `computeAvailabilityRank` 纯函数（采集器统一调用，避免排序语义分叉）。
- 单元测试：分类、排序、schema（生成列/外键/唯一索引）。

## M2 已实现（采集编排）

- `server/collectors/` — 阶段 A 采集器：`kami` / `dujiao` / `shopApi` / `genericHtml` / `browser`，+ `registry`（按域名嗅探 `auto`）+ `index`（`collectorFor`，阶段 B 与未知类型抛 `UnsupportedCollectorError`）。采集器接收可注入的 HTTP 客户端，便于单测。
- `server/core/ids.ts` — `urlCanonical`（白名单 id 参数）、`resolveExternalKey`（外部键→url→标题）、`buildOfferId`、`withVariant`（dujiao 多 SKU）。
- `server/core/freshness.ts` — `computeFreshnessFields`（测活字段，走 `computeAvailabilityRank`）、`shouldDelistMissing`（差集下架硬规则，纯函数）。
- `server/core/http.ts` — 带 SSRF 防护 + 超时的 `httpClient`。
- `server/db/repo.ts` — `upsertOffers` / `delistMissing` / 源级锁(取/续/释放/清扫) / `markSourceSuccess|Failure` / 来源读写。
- `server/core/orchestrator.ts` — `collectSource`（取锁→采集→事务[upsert+差集下架]→记日志/健康→finally 释放锁）、`runAllSources`（并发上限；任一源被锁跳过则整体 partial + skippedSources）。
- `server/core/jobs.ts` — 入队 DB 级防重 + 全量/单源互斥；`runJob` 串行执行。
- `server/collect.ts` — 采集 CLI。

浏览器采集器需要本机 Chrome 与 `playwright-core`（按需安装：`npm i playwright-core`），未安装时其余 HTTP 采集不受影响。

## 使用

```bash
npm install          # 需要能编译 better-sqlite3 的环境（macOS 用预编译包，秒装）
npm run db:init      # 生成 server/db/shop.db 并写入分类目录
npm test             # 运行全部单元测试

# 采集（先在库里有 source；M3 起后台可增删店铺）
npm run collect -- --source <sourceId>
npm run collect -- --all --concurrency 15
```

环境变量：`SHOP_DB_PATH` 覆盖数据库位置；`BROWSER_PATH` 指定浏览器；`BROWSER_HEADLESS=0` 显示窗口。

## M3a 已实现（后端 API）

- `server/api/server.ts` — Fastify 实例 `buildServer(db, deps)`，单写者模型，含 CORS。
- `server/core/scheduler.ts` — 进程内串行调度器（一次一个 job）+ 启动崩溃恢复（清过期锁、僵尸 running 任务标失败）。
- `server/db/data.ts` — 读查询：`listProducts`（按 search_group 聚合、有货最低价代表、平台筛选/关键字/分页）、`getProductOffers`、店铺/日志/任务视图。
- `server/db/reclassify.ts` — 用最新规则重建分类。
- `server/index.ts` — 服务入口（建库 → 恢复 → 监听）。

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET/POST | `/api/sources` | 列出 / 新增店铺 |
| PATCH/DELETE | `/api/sources/:id` | 改 / 删（`?deleteOffers=1` 连带删报价） |
| POST | `/api/collect` | 入队 `{all}`/`{sourceId}`，202 返回 jobId，后台串行执行 |
| GET | `/api/jobs` `/api/jobs/:id` | 任务列表 / 状态 |
| GET/POST | `/api/verify/pending` `/api/verify/start` | 待人工验证店铺 / 启动一键验证窗口 |
| GET/POST | `/api/verify/status` `/api/verify/cancel` | 一键验证进度 / 取消当前验证会话 |
| GET | `/api/crawl-runs` | 采集日志（`?sourceId=&limit=`） |
| POST | `/api/reclassify` | 重建分类，返回分布 |
| GET | `/api/products` | 商品聚合列表（`?platform=&q=&page=&pageSize=`） |
| GET | `/api/products/:id/offers` | 某标准品各店铺报价 |

### 启动后端

```bash
npm start        # tsx server/index.ts，默认 http://127.0.0.1:3000
npm run dev      # 带热重载
# 环境变量：PORT / HOST / SHOP_DB_PATH
```

## M3b 已实现（后台界面，`web/`）

React + Vite + TypeScript 单页应用，对接后端 API：

- 店铺管理：新增（名称 / 入口 URL / 采集器类型）、启停、删除、健康状态与上次成功时间。
- 采集：「采集全部 / 单个」按钮，轮询 `/api/jobs`，运行中自动禁用重复点击。
- CF 盾站一键验证：顶部显示待验证数量，点击「一键验证」弹出共享 profile 的有头 Chrome，挑战通过后自动就地采集并恢复健康状态。
- 采集日志：自动刷新的 crawl-runs 列表。
- 顶部「重建分类」按钮；前台/后台切换（前台为 M4 占位）。

### 运行方式

单进程（推荐，后端托管已构建的前端，一个端口）：

```bash
cd shop-manager
npm run setup        # = npm install + 构建前端(web/dist) + 初始化数据库
npm start            # http://127.0.0.1:3000  （同时提供 API 与后台界面）
```

开发模式（前后端分离 + HMR，两个终端）：

```bash
cd shop-manager && npm install && npm start           # 后端 3000
cd shop-manager/web && npm install && npm run dev      # 前端 5173（/api 代理到 3000）
```

### 接入统一门户

已加入 `订阅续费管理系统/portal.py` 的 `SYSTEMS`（key `shop-manager`，端口 3000，卡片图标 🛒），
和「订阅续费管理」「团队成员管理」一样由门户一键启动。门户用 `npm start` 拉起单进程（后端 + 前端）。

前置：先在 `shop-manager/` 跑过一次 `npm run setup`（装依赖 + 构建前端），门户才能正常托管界面。
目录默认 `<code>/shop-manager`，可用环境变量 `SHOP_MANAGER_DIR` 覆盖。

## M4 已实现（前台浏览，`web/src/front/`）

- `FrontBrowse.tsx` — 按标准品聚合的商品卡片网格，分类筛选（ChatGPT/Claude/…）、关键字搜索（防抖，后端 SQLite + 规则打分）、分页；卡片显示最低价、在售家数、有货/缺货。
- `ProductDetail.tsx` — 点卡片进入，多店铺报价对比（有货优先、价格升序），有货项可「购买」跳转。
- 默认进入前台；顶部按钮切「进入后台」。

## M5 已实现（收藏）

- 后端 `server/db/favorites.ts` + 路由：收藏 offer（带快照、offer_id/URL 双重去重、幂等）、列表回查现价/状态（id 漂移按 URL+SKU 键重定位，否则标失效）、取消。
- 前端：商品详情每条报价的 ☆ 星标即点即收藏；前台「我的收藏」页（收藏价 vs 现价、跳转、移除）。

## 门户接入与启动健壮性

- 后端**始终注册**前端静态托管（启动时无 dist 也先放占位），`index.html` 设 `no-cache`：`npm run build:web` 后刷新即更新，无需重启后端。
- `db:init` 会把当前 node 绝对路径写入 `.node-path`；`订阅续费管理系统/portal.py` 用它固定架构启动后端，绕开 `.app` 精简 PATH 命中 x64 旧 node 导致 esbuild 崩溃的问题（回退 `npm start`）。
- 因此首次接入门户务必先在 `shop-manager/` 跑一次 `npm run setup`（装依赖 + 构建前端 + 写 `.node-path`）。

## 采集说明（识别 / WAF 站点 / 库存）

- **采集器自动识别（`auto`）**：先按域名注册表；未知域名会**实地探测接口形态**——`/shop/<token>`→shopApi、`/user/api/index/commodity` 有数据→kami（卡网/异次元发卡）、`/api/v1/public/products` 有数据→dujiao（独角数卡）。所以换个新域名的同类站点也能直接采，**不必再逐个把域名加进代码**。都探不到才判「暂不支持」。


- **WAF / 需验证的站点**（如链动小铺 `pay.ldxp.cn`、CF 盾站）：HTTP 采集命中风控会自动**回退到浏览器采集器**（Playwright + 本机 Chrome），默认无头运行；浏览器采集与一键验证共用 persistent profile，cookie 可复用。
  - 前置：已装 `playwright-core`（在依赖里）+ 本机 Chrome/Edge/Brave。
  - 浏览器采集**默认无头**，并有**启动超时 + 总超时**（默认 90s），到点必定中止、释放锁、记状态，绝不无限挂起。
  - Cloudflare 挑战页会被轮询检测；无头模式无法通过时会把店铺标记为 `manual_required`（前台显示「待验证」），不增加连败、不把旧报价标失效。
  - 在后台点「一键验证」会打开一个有头 Chrome 窗口，每个待验证站点一个标签页；挑战通过后后端自动在页面里提取报价、写库并恢复 healthy。验证期间 browser 类采集会等待同一个 profile 锁，HTTP 类采集不受影响。
  - 相关环境变量：`SHOP_BROWSER_PROFILE`（默认 `~/.shop-manager/browser-profile`）；`BROWSER_HEADLESS=0` 改为可见窗口；`BROWSER_CHALLENGE_TIMEOUT_MS`（默认 24000）；`BROWSER_CHALLENGE_POLL_MS`（默认 2000）；`BROWSER_RENDER_WAIT_MS`（默认 12000，通用浏览器采集等待 SPA 渲染）；`BROWSER_WAIT_MS`（默认 8s，ShopApi 浏览器接口采集等待用）；`BROWSER_TIMEOUT_MS`（默认 90s）；`BROWSER_PATH` 指定浏览器；`SHOP_NO_BROWSER_FALLBACK=1` 关闭自动回退。
  - 后端启动时会**清掉所有残留源锁**并把僵尸 `running` 任务标失败，避免上一轮挂死把某个源/队列卡住。
  - **终端人工验证模式**仍保留作为兜底：在终端跑
    `npm run collect:manual -- --url <店铺链接>`，会弹出**可见浏览器**，你手动过验证/滑块/登录、看到商品页后回终端按回车，它就调接口采集并写库（链动小铺/ShopApi 走页面内调接口，其它走 DOM）。采完回前台刷新即可。
  - 也可直接把该店铺的采集器类型设为 `browser`。
- **定性库存**：部分发卡站（如异次元 `ifaka.app`）库存是文字（「非常多」），不是数字。现已原样保留为 `stock_text` 并在商品详情「库存」列展示；状态按有货处理。

## M6 已实现（SQLite offer 级精准搜索）

前台分成两个模式：空关键词是**商品组浏览**（一条卡片 = 一个 `search_group`，用于比价入口）；有关键词时是**具体报价搜索**（一条卡片 = 一个有效在售 offer，显示命中的店铺商品标题、店铺、价格，同时保留所属标准品用于点击比价）。SQLite 仍是唯一真相源。

- `server/db/data.ts` — 空关键词 `listProducts` 按 `search_group` 聚合；关键词 `searchOffers` 返回 offer 级结果，支持相关度/价格排序。
- 搜索文档：每个有效在售 offer 生成一份临时文档；高权重字段为标准品名、别名、平台、商品类型、规格和组合身份文本；中权重字段为店铺商品标题；不搜索店铺名、来源名。
- 匹配规则：ASCII 查询统一小写、去符号并切 token；长度 >= 4 且非泛词的具体词支持大小写无关包含匹配；短词按 token 边界匹配，避免 `pix` 误命中 `pixel`；`gpt`、`plus`、`pro`、`api`、`ai` 等泛词不单独从标题召回，只通过标准品字段命中。
- 多词查询要求 token 都命中，但允许分布在不同字段，例如 `gpt plus` 可由 `ChatGPT` + `Plus` 命中。
- 路由：`GET /api/search?q=&platform=&sort=relevance|price&page=&pageSize=`。相关度排序先看精确/高权重字段/标题命中，价格排序在命中集合内按价格和库存排序。
