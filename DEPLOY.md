# 部署到 Linux 云服务器（定时采集）

面向 2 核 / 2.5G 级别的小服务器。架构本身很轻（SQLite 进程内 + 单写者 + 串行任务调度），
真正需要注意的是**出口 IP 的风控**和**浏览器采集的内存**。

## 一、出口 IP 与风控：最重要的一节

采集目标多为国内发卡站（链动小铺、异次元卡网、独角数卡等），部分挂在阿里云 ESA / Cloudflare 后面。

**已实测的结论**：境外 IP 本身不会被直接拒绝——同一个境外出口在低频访问时一切正常（HTTP 200，采集成功）；
真正触发封禁的是**短时间内对同一域名的高密度请求**。一次全量采集后该域名对这个 IP 全部返回 `520`
（首页、HTML、API 全挂），而同一时刻手机移动网络访问完全正常，持续数小时不恢复。

所以**境外 VPS 完全可用**，前提是把请求密度压下来。

### 境外 VPS 推荐配置

```bash
SHOP_HTTP_HOST_MIN_GAP_MS=1500   # 同域名两次请求最小间隔（最关键）
SHOP_HTTP_JITTER_MS=600          # 随机抖动，避免固定节奏的机器特征
SHOP_COLLECT_HOST_CONCURRENCY=1  # 同域名串行
SHOP_COLLECT_HOST_DELAY_MS=2000  # 同域名两个店铺之间再留间隔
SHOP_COLLECT_INTERVAL_MINUTES=1440  # 每天一次足够
```

按这个配置，同域名下 20+ 家店铺（约 200 个接口请求）一轮约需 5–8 分钟跑完。
每天只跑一次，这个密度对站点几乎无感，被风控的概率很低。

其它降低风险的做法：

- **机房位置**：香港 / 日本 / 新加坡的线路与 IP 段，通常比欧美 IP 更不容易被国内站风控。
- **错峰**：把每天那一次放在凌晨（站点低峰期）。
- **真被封了也不会雪崩**：见第七节的「同域名熔断」——一家被限流，本轮该域名其余店铺自动跳过，
  不会继续猛打把封禁加深；这些店铺记为 `skipped` 而非失败，不会污染健康状态。第二天正常重试即可。

### 本机开发的坑

若本机使用 Clash/Surge 的 **TUN 全局模式**（`ifconfig` 能看到 `utun`、默认路由指向它），
所有请求都会走代理出口——包括 `curl --noproxy` 和指定真实 IP 的请求，也包括本项目的采集。
调试「站点是不是挂了」时会严重误导。建议在代理规则里让国内域名直连。

## 二、安装

```bash
# Node 20+ 与构建 better-sqlite3 所需工具
sudo apt update && sudo apt install -y nodejs npm build-essential python3

sudo mkdir -p /opt/shop-manager/data && sudo chown -R "$USER" /opt/shop-manager
cd /opt/shop-manager
# 上传或 git clone 代码到此目录，然后：
npm install
npm run build:web
npm run db:init
```

浏览器采集（只有少数站点需要）额外装 Chromium 与 playwright-core：

```bash
sudo apt install -y chromium-browser        # 或 chromium
npm i playwright-core
```

## 三、配置

```bash
cp .env.example .env
```

关键项：

| 变量 | 建议值 | 说明 |
| --- | --- | --- |
| `SHOP_DB_PATH` | `/opt/shop-manager/data/shop.db` | **必须放本地磁盘**。放网盘/NFS 会让 SQLite 随机读写出错甚至损坏 |
| `HOST` | `127.0.0.1` | 由 Nginx 反代，不要把后端直接暴露公网 |
| `SHOP_COLLECT_INTERVAL_MINUTES` | `1440`（每天一次） | 全量采集间隔；`0`=不定时采集，下限 5 分钟 |
| `SHOP_HTTP_HOST_MIN_GAP_MS` | 国内 `500` / 境外 `1500` | **最关键**：同域名两次 HTTP 请求的最小间隔 |
| `SHOP_HTTP_JITTER_MS` | `400`–`600` | 请求间隔的随机抖动 |
| `SHOP_COLLECT_HOST_CONCURRENCY` | `1`（默认） | 同域名并发。几十家店常同域名，并发打必被限流 |
| `SHOP_COLLECT_HOST_DELAY_MS` | `1500`（默认） | 同域名两个店铺之间的间隔 |
| `SHOP_BROWSER_CONCURRENCY` | `1`（默认） | 每个无头 Chrome 约 300–600MB |
| `BROWSER_PATH` | `/usr/bin/chromium` | Linux 上通常需显式指定 |

默认值已按「避免触发风控 + 小内存」调好，一般不用改。

## 四、内存：加 swap

2.5G 内存跑无头 Chrome 会吃紧，务必加 swap 兜底：

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Chrome 启动参数已包含 `--disable-dev-shm-usage`（Linux 上 `/dev/shm` 默认仅 64MB，
不加这个参数无头 Chrome 会崩标签页）。

## 五、systemd 常驻

`/etc/systemd/system/shop-manager.service`：

```ini
[Unit]
Description=Shop Manager
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/shop-manager
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=YOUR_USER
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shop-manager
sudo systemctl status shop-manager
journalctl -u shop-manager -f
```

进程重启时会自动做崩溃恢复：清理过期源锁、把僵尸 `running` 任务标记为 failed。

## 六、定时采集怎么跑的

进程内定时器，无需系统 cron：到点入队一个全量任务，由既有串行调度器执行。
`collection_jobs` 上的部分唯一索引保证**同时只有一个活动全量任务**，
所以上一轮没跑完时，这一轮只会跳过，不会堆积。

启动日志会打印当前状态：

```
定时采集：每 180 分钟一次全量采集
```

若想改用系统 cron 或外部触发，把 `SHOP_COLLECT_INTERVAL_MINUTES` 留空，
改为定时调用 `POST /api/collect {"all": true}`。

## 七、采集的自我保护（了解即可）

- **同域名熔断**：某域名一旦返回 `429/52x/403`，本轮**跳过该域名其余店铺**，
  记为 `skipped` 而非 `failed`（不累加连败、不污染店铺健康状态）。避免一家被限流后，
  同站几十家继续猛打把封禁打得更深。
- **类型自愈**：存量采集器类型失效时（站点改版、类型误判），采集失败/采空会自动重新识别类型并重试一次，
  等价于「删除店铺重新添加」。但**上游临时错误**（限流 / 5xx / 52x / 超时）不触发自愈——
  那种情况类型没错，只需稍后重试，重新识别反而会加倍打站点。
- **风控回退浏览器**：HTTP 被验证码/风控拦截时自动改用浏览器采集；链动小铺类站点会
  用「浏览器过 WAF + 页面内调接口」拿结构化数据，而不是抓 DOM。

## 八、Nginx 反代（可选）

```nginx
server {
    listen 80;
    server_name your.domain;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

后台没有鉴权，若绑公网域名，请在 Nginx 上加 basic auth 或 IP 白名单。

## 九、备份

```bash
sqlite3 /opt/shop-manager/data/shop.db ".backup '/opt/shop-manager/data/backup-$(date +%F).db'"
```

WAL 模式下不要直接 `cp` 数据库文件，用 `.backup` 命令。
