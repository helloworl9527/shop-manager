import dns from "node:dns/promises";

const TIMEOUT_MS = 20_000;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** 采集器使用的最小 HTTP 客户端接口，便于单测注入假实现。 */
export interface HttpClient {
  fetchJson(url: string): Promise<any>;
  fetchText(url: string): Promise<string>;
  postJson(url: string, body: unknown, referer?: string): Promise<any>;
}

// ---------------- SSRF 防护 ----------------

export function isPrivateAddress(address: string): boolean {
  const lower = String(address || "").trim().toLowerCase();
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (lower === "localhost" || lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.split(":").pop() || "");
  return false;
}

async function ensurePublicHost(hostname: string): Promise<void> {
  if (!hostname) throw new Error("URL 缺少主机名。");
  if (isPrivateAddress(hostname)) throw new Error("不允许访问内部地址。");
  let records: { address: string }[] = [];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`无法解析主机名：${hostname}`);
  }
  for (const r of records) {
    if (isPrivateAddress(r.address)) throw new Error("解析到内部 IP，已拒绝。");
  }
}

function deriveBaseUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return value;
  }
}

function defaultHeaders(url: string): Record<string, string> {
  return {
    accept: "application/json,text/html;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
    referer: deriveBaseUrl(url),
    "user-agent": UA,
  };
}

// ---------------- 按域名限速 ----------------
//
// 采集单个店铺内部会连续打多个接口（info / categoryList / goodsList 逐分类逐页），
// 而几十家店铺常挂在同一域名下（如 20+ 家链动小铺同在 pay.ldxp.cn）。
// 若不限速，一轮全量采集会在几分钟内对同一域名打出几百个请求——这正是触发
// 「整站 520 / 封出口 IP」的原因，且从境外 VPS 访问国内站时尤其敏感。
//
// 这里做全局的 per-host 最小间隔：所有采集器共用同一个 httpClient，因此天然覆盖全部采集路径。

const lastRequestAt = new Map<string, number>();

/** 同域名两次请求的最小间隔（毫秒）。境外 VPS 建议调大到 1000–1500。 */
export function hostMinGapMs(): number {
  const value = Number(process.env.SHOP_HTTP_HOST_MIN_GAP_MS ?? 500);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 500;
}

/** 抖动上限：固定间隔本身就是机器特征，加随机量让节奏更像真人。 */
function jitterMs(): number {
  const value = Number(process.env.SHOP_HTTP_JITTER_MS ?? 400);
  const max = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 400;
  return max > 0 ? Math.floor(Math.random() * max) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等到该域名允许下一次请求为止。串行等待，保证同域名请求之间始终留有间隔。 */
async function throttleHost(hostname: string): Promise<void> {
  const minGap = hostMinGapMs();
  if (minGap <= 0) return;
  const now = Date.now();
  const earliest = (lastRequestAt.get(hostname) ?? 0) + minGap + jitterMs();
  // 先占位再等待：并发调用会依次排到各自的时间片，避免同时放行。
  const scheduled = Math.max(now, earliest);
  lastRequestAt.set(hostname, scheduled);
  if (scheduled > now) await sleep(scheduled - now);
}

async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅允许 http/https。");
  await ensurePublicHost(u.hostname);
  await throttleHost(u.hostname);
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function parseJsonResponse(response: Response, url: string): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    if (/<html|<script|captcha|verify|challenge|验证|风控|安全/i.test(text)) {
      throw new Error(`${url} 返回验证或风控页面，需要改用本机浏览器采集。`);
    }
    throw new Error(`${url} 返回了非 JSON 内容，暂时无法自动采集。`);
  }
}

/** 默认 HTTP 客户端（带 SSRF 防护 + 超时）。 */
export const httpClient: HttpClient = {
  async fetchJson(url) {
    const res = await guardedFetch(url, { headers: defaultHeaders(url) });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return parseJsonResponse(res, url);
  },
  async fetchText(url) {
    const res = await guardedFetch(url, { headers: defaultHeaders(url) });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return res.text();
  },
  async postJson(url, body, referer) {
    const res = await guardedFetch(url, {
      method: "POST",
      headers: {
        ...defaultHeaders(referer || url),
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        visitorid: `probe${Math.random().toString(36).slice(2, 10)}`,
        referer: referer || url,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return parseJsonResponse(res, url);
  },
};
