# shop-manager

自建的**发卡站商品采集与比价系统**。定时把几十家店铺的商品和价格抓回本地 SQLite，按标准品聚合，一眼看清同一件商品在哪家最便宜。

前后端同进程：Fastify + SQLite 后端，React + Vite 前端，一个端口同时提供 API 和界面。

---

## 它解决什么问题

同一个 ChatGPT Plus 账号，几十家发卡站都在卖，价格从几毛到几百不等，还经常缺货。手动一家家开页面比价不现实。

这个系统做三件事：

1. **采集** —— 自动识别店铺用的是哪套建站程序（链动小铺 / 独角数卡 / 异次元卡网 / 纯前端 SPA…），调对应接口把商品抓回来；
2. **归一** —— 把各家五花八门的商品标题（`CLAUDE MAX 20x 月卡【订阅成品号丨质保30天】`、`Claude max20 质保订阅`）归到同一个**标准品**下；
3. **比价** —— 前台按标准品聚合展示，点进去看各店铺报价，有货的可以直接跳转购买。

---

## 主要功能

### 采集

- **采集器自动识别**。新增店铺时先查域名注册表，未知域名就**实地探测接口形态**——`/shop/<token>` → 链动小铺、`/user/api/index/commodity` 有数据 → 卡网、`/api/v1/public/products` 有数据 → 独角数卡……所以换个新域名的同类站点直接就能采，不必逐个把域名写进代码。都探不到才判「暂不支持」。
- **已实现的采集器**：`shopApi`（链动小铺）、`dujiao` / `dujiaoHtml`（独角数卡）、`kami`（卡网 / 异次元发卡）、`publicProductsApi`、`productsListApi`、`genericHtml`、`browser`、`priceaiApi`、`aihaotanApi`。
- **聚合源**。链动小铺是本站最大的一片，也正是直采要靠大陆代理才够得着的那批。接入第三方聚合站等于免费拿到那一大片店铺：**直连即可，不消耗按 IP 计费的代理额度**。两个源互补，都保留。

  `priceaiApi`（priceai.cc）。公开无鉴权接口，收录数百家发卡站的报价快照，其中约九成是链动小铺，也覆盖少量其他平台。
  - 接口 `offset` 上限 5000 而总量已超 6500，所以按 `platform` 分片扫，平台枚举从 `/api/merchants` 动态发现（写死一份的话对方新增平台我们会静默漏采）。
  - **自动跳过我们已直采的店铺**：同一家店重复收录会让它在比价页出现两次、「在售家数」也翻倍。判定用「可注册域名 + /shop/token」——两边子域对不上（我们存 `pay.ldxp.cn`，对方给 `www.ldxp.cn`），只比完整域名的话去重会形同虚设。
  - 它是快照不是实时库存，`status` 照抄不做二次推断；外部键用商品 URL 而非对方的 `offer.id`（那是快照内标识，一漂移就会每轮整批下架再整批新增）。

  `aihaotanApi`（aihaotan.com / AI号探）。**只收录链动小铺**，约 1.15 万条商品、三百多家店铺，是 priceai 之外的另一片覆盖——两边商品重合只有约一成半。
  - `limit` 硬顶 96，但 `offset` **没有上限**，所以不必像 priceai 那样分片，直接翻到底即可（约 120 次请求）。
  - 它给的是**真实库存数字**（实测最小值就是 1），所以状态可以放心用 `statusFromStock` 推断，不像 priceai 只能照抄快照 status。
  - **只收录有货商品**，一条零库存都没有。所以商品从列表消失，可能是卖光也可能是下架，两者分不开——这正好对上 `delistMissing` 的语义：标 `hidden` + `out_of_stock`，「再次返回自动恢复」，不做店铺死亡判定。
  - 数据比隔夜的直采更新。实测两边价格分歧的条目，拿代理打链动实时接口仲裁，**是我们旧、它对**。但它仍是天粒度快照，所以只当广度补充，不覆盖直采。
- **风控自动回退浏览器**。HTTP 采集撞上验证码/风控页时自动改用 Playwright 无头浏览器；无头过不了的会标成「待验证」，可在后台一键打开有头窗口人工过一次。
- **限速与熔断**。同域名串行 + 可配最小间隔 + 随机抖动；某域名一旦返回 429/52x/403，本轮跳过该域名其余店铺，避免把封禁打得更深。
- **失效店铺自动停用**。只停用**不会自己恢复**的：站点答复「店铺链接不存在」、接口 404/410、长期无商品。403/5xx/超时一律不算——那是风控或临时故障，停掉就再也不会自己好。详见 [DEPLOY.md](DEPLOY.md)。
- **出口 IP 代理**（可选）。部分站点（如链动小铺）对境外 IP 返回地域拒绝或滑块验证，可接入快代理私密代理换大陆出口。**只有这类店铺走代理**，其余一律直连——代理按 IP 个数计费，全站走代理是纯浪费。

### 前台

- **按标准品聚合浏览**，卡片显示最低价、在售家数、有货状态；点进去看各店铺报价对比。
- **offer 级搜索**。空关键词是商品组浏览；有关键词时一条结果 = 一个具体在售报价，显示命中的店铺商品标题与价格。**默认按价格排序**，可切「相关度」。
- **有货与库存紧张同档**，价格才是首要排序标准——这是比价工具，不该让 ¥682 有货的排在 ¥455 库存紧张的前面。
- **收藏**：商品级收藏（存快照，商品下架也能回看现价对比）；店铺级收藏（见下）。
- **夜间模式**。顶栏 ☾/☀ 切换，记在 localStorage；没手动选过时跟随系统。

### 收藏店铺链接

收藏页可以直接粘链接收藏店铺，**不访问站点、不采集商品**——纯粹当书签用。店铺名和链接都自己填，支持自定义分类（自由填写，已有分类会下拉补全），列表按分类分组。后台给采集店铺点 ★ 的店显示在同一个列表里并带 ★ 标记，两边同步。

### 后台

店铺增删改查与启停、健康状态、手动触发采集（全部 / 单个）、采集日志、重建分类、一键人工验证。

---

## 快速开始

需要 **Node 20+**（推荐 22，见下方「已知坑」）。

```bash
git clone https://github.com/helloworl9527/shop-manager.git
cd shop-manager

npm run setup     # = npm install + 构建前端 + 初始化数据库
npm start         # http://127.0.0.1:3000
```

开发模式（前后端分离 + 热更新，两个终端）：

```bash
npm start                      # 后端 3000
cd web && npm run dev          # 前端 5173，/api 代理到 3000
```

常用命令：

```bash
npm test                                   # 单元测试
npm run typecheck                          # 类型检查
npm run collect -- --all --concurrency 15  # 命令行采集
npm run collect -- --source <sourceId>
npm run collect:manual -- --url <店铺链接>  # 弹可见浏览器，人工过验证后采集
npm run migrate:kinds                      # 重新识别所有店铺的采集器类型
npm run build:web                          # 只重建前端（刷新即生效，不必重启后端）
```

---

## 配置

配置从 `.env` 读取（复制 `.env.example` 修改）。**改完必须重启进程才生效**——`.env` 是应用启动时自己读的。

最常用的几项：

| 变量 | 说明 |
| --- | --- |
| `PORT` / `HOST` | 监听地址，默认 `3000` / `127.0.0.1` |
| `SHOP_DB_PATH` | SQLite 路径。务必放本地磁盘，不要放网盘/NFS |
| `SHOP_COLLECT_INTERVAL_MINUTES` | 进程内定时采集间隔，`0` = 关闭（用系统 timer 更稳） |
| `SHOP_HTTP_HOST_MIN_GAP_MS` | 同域名两次请求的最小间隔，**最关键的一项**。国内机器 500 即可，境外 VPS 建议 1200–1500 |
| `SHOP_COLLECT_HOST_CONCURRENCY` | 同域名并发，默认 1 |
| `BROWSER_PATH` | 浏览器可执行文件路径，Linux 上通常需显式指定 |
| `SHOP_NO_BROWSER_FALLBACK` | `1` = 完全禁用「风控后回退浏览器」 |
| `SHOP_RETIRE_EMPTY_ROUNDS` | 空店连续多少轮才自动停用，默认 7，`0` = 关闭 |
| `SHOP_PROXY_KDL_*` | 快代理私密代理凭据，四项配齐才启用；不配则全部直连 |

完整列表见 [`.env.example`](.env.example)，部署与运维见 [DEPLOY.md](DEPLOY.md)。

---

## 架构

```
server/
  api/server.ts          Fastify 实例，所有路由
  collectors/            各建站程序的采集器 + registry（自动识别的探测瀑布）
  core/
    orchestrator.ts      采集编排：取锁 → 采集 → 事务(upsert + 差集下架) → 记日志 → 释放锁
    http.ts              带 SSRF 防护、限速、代理分流的 HTTP 客户端
    proxy.ts             出口 IP 代理与「谁该走代理」的判定
    retirement.ts        失效店铺自动停用
    jobs.ts scheduler.ts 任务队列（DB 级防重）与串行调度器
    freshness.ts         测活字段与「差集下架」硬规则
    ids.ts               offer id / 外部键 / URL 规范化
  catalog/catalog.ts     标准品目录与 classifyOffer（商品归一）
  db/                    schema、连接、读写仓储
web/src/
  front/                 前台：浏览、商品详情、收藏
  admin/                 后台：店铺管理、采集日志
```

**数据表**：`canonical_products`（标准品）、`sources`（采集店铺）、`raw_offers`（报价）、`crawl_runs`（采集日志）、`favorites`（商品收藏）、`favorite_stores`（店铺收藏）、`collection_jobs`（任务队列）。

**单写者模型**：SQLite 走 WAL，写操作全部经由串行调度器，同一时刻只有一个采集任务在跑。进程启动时会清掉残留的源锁并把僵尸 `running` 任务标失败，避免上一轮挂死卡住队列。

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/products` | 按标准品聚合的商品列表 |
| GET | `/api/products/:id/offers` | 某标准品的各店铺报价 |
| GET | `/api/search` | offer 级搜索（`q` / `platform` / `sort=price\|relevance` / 分页） |
| GET POST | `/api/sources` | 列出 / 新增店铺 |
| PATCH DELETE | `/api/sources/:id` | 改 / 删（`?deleteOffers=1` 连带删报价） |
| POST | `/api/sources/probe` | 探测某链接的采集器类型并试采预览 |
| POST | `/api/sources/:id/reidentify` | 重新识别采集器类型 |
| POST | `/api/collect` | 入队 `{all:true}` 或 `{sourceId}`，202 返回 jobId |
| GET | `/api/jobs` `/api/jobs/:id` | 任务列表 / 状态 |
| GET | `/api/crawl-runs` | 采集日志 |
| POST | `/api/reclassify` | 用最新规则重建分类 |
| GET POST DELETE | `/api/favorites` | 商品级收藏 |
| GET POST | `/api/favorite-stores` | 店铺收藏列表 / 新增 |
| PATCH DELETE | `/api/favorite-stores/:id` | 改名改分类 / 移除 |
| GET POST | `/api/verify/*` | 待验证店铺、一键验证窗口的启动/进度/取消 |

---

## 已知坑

- **Node 版本**：`better-sqlite3` v11 最高只提供到 ABI 135 的预编译包，**Node 24 会退化成源码编译**（很慢且需要编译工具链）。用 **Node 22** 可以秒装。
- **`.env` 改完要重启**：不是 systemd 注入的环境变量，而是应用启动时自己读的。不重启就会静默按旧配置跑。
- **测试会读真实 `.env`**：如果本地 `.env` 里设了 `SHOP_NO_BROWSER_FALLBACK=1`，`npm test` 会多挂几个用例。这是测试环境耦合，跑测试前留意。
- **不要用 apt/snap 版 chromium**：AppArmor 会拒绝它写 profile 目录（`SingletonLock: Permission denied`）。用 `npx playwright-core install chromium`。
- **升级后跑 `npm run db:init`**：建表是幂等的，同时负责补列和数据迁移。`applySchema` 不在服务启动时执行。

---

## 说明

自用项目，按自己的需求长出来的，没有做通用化。采集逻辑针对特定几类建站程序，换一类站点需要自己写采集器（照着 `server/collectors/` 里现有的写，接口很小）。
