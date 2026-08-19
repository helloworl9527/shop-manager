import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { Resolver } from "node:dns/promises";
import { ProxyAgent, type Dispatcher } from "undici";
import { isPrivateAddress } from "./http";

// 出口 IP 代理池。
//
// 采集失败的根因是「单一出口 IP 对同一域名的请求密度过高」——站点先返回 520，
// 严重时弹滑块验证。加大间隔能缓解，但一轮全量采集要跑几十家店铺，单 IP 的总量下不去。
// 代理池换个思路：把请求摊到 N 个出口 IP 上，每个 IP 看到的密度降为 1/N。
//
// 关键是**会话粘性**：链动小铺一类站点会在一次会话里带 visitorid / cookie，
// 同一家店铺的 info / categoryList / goodsList 若来自不同 IP，反而更像异常流量。
// 所以按「店铺」分配代理，一家店铺全程走同一个出口，店铺之间才轮换。

export interface ProxyEntry {
  id: string;
  /** 给 undici / playwright 用的完整地址，形如 http://host:port */
  server: string;
  username?: string;
  password?: string;
  /** 含认证信息的完整 URL，仅内部构造 ProxyAgent 用 */
  url: string;
}

/**
 * 解析一行代理配置。支持两种写法：
 *   host:port:user:pass
 *   http://user:pass@host:port
 * 空行与 # 开头的注释返回 null。
 */
export function parseProxyLine(line: string): ProxyEntry | null {
  const text = String(line ?? "").trim();
  if (!text || text.startsWith("#")) return null;

  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      if (!u.hostname || !u.port) return null;
      return makeEntry(u.hostname, u.port, decodeURIComponent(u.username), decodeURIComponent(u.password));
    } catch {
      return null;
    }
  }

  // host:port:user:pass —— 密码本身可能含冒号，故只切前三个分隔符
  const parts = text.split(":");
  if (parts.length < 2) return null;
  const host = parts[0] ?? "";
  const port = parts[1] ?? "";
  const user = parts[2] ?? "";
  const rest = parts.slice(3);
  if (!host || !/^\d+$/.test(port)) return null;
  return makeEntry(host, port, user, rest.join(":"));
}

function makeEntry(host: string, port: string, username: string, password: string): ProxyEntry {
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  return {
    id: `${host}:${port}${username ? `#${username}` : ""}`,
    server: `http://${host}:${port}`,
    username: username || undefined,
    password: username ? password : undefined,
    url: `http://${auth}${host}:${port}`,
  };
}

export function parseProxyList(text: string): ProxyEntry[] {
  const seen = new Set<string>();
  const out: ProxyEntry[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const entry = parseProxyLine(line);
    if (!entry) continue;
    // 代理服务器本身指向内网 = 有人拿它绕 SSRF 防护，直接丢弃
    if (isPrivateAddress(new URL(entry.server).hostname)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

// ---------------- 池的加载 ----------------

let cachedPool: ProxyEntry[] | null = null;
let cachedFrom = "";

/** 代理列表文件路径；未配置则不启用代理池。 */
function proxyFile(): string {
  return String(process.env.SHOP_PROXY_FILE ?? "").trim();
}

export function loadProxyPool(): ProxyEntry[] {
  if (process.env.SHOP_PROXY_ENABLED === "0") return [];
  const file = proxyFile();
  if (!file) return [];
  if (cachedPool && cachedFrom === file) return cachedPool;
  try {
    cachedPool = parseProxyList(readFileSync(file, "utf8"));
  } catch {
    cachedPool = [];
  }
  cachedFrom = file;
  return cachedPool;
}

/** 测试与配置变更后重置内部状态。 */
export function resetProxyPool(): void {
  cachedPool = null;
  cachedFrom = "";
  assignments.clear();
  cooldownUntil.clear();
  for (const agent of agents.values()) void agent.close().catch(() => {});
  agents.clear();
  resolvedGateways.clear();
  resolver = null;
  cursor = 0;
  kdlEntry = null;
}

export function proxyPoolEnabled(): boolean {
  return loadProxyPool().length > 0;
}

// ---------------- 会话粘性与轮换 ----------------

const session = new AsyncLocalStorage<string>();
/** 会话 key → 代理 id */
const assignments = new Map<string, string>();
/** 代理 id → 冷却截止时间戳 */
const cooldownUntil = new Map<string, number>();
let cursor = 0;

/** 代理连不通后的冷却时长（毫秒）。冷却期内不再分配给新会话。 */
function cooldownMs(): number {
  const value = Number(process.env.SHOP_PROXY_COOLDOWN_MS ?? 10 * 60 * 1000);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 10 * 60 * 1000;
}

function healthy(pool: ProxyEntry[]): ProxyEntry[] {
  const now = Date.now();
  const ok = pool.filter((p) => (cooldownUntil.get(p.id) ?? 0) <= now);
  // 全部在冷却中：与其整轮采集失败，不如放行全部重试一次
  return ok.length > 0 ? ok : pool;
}

/**
 * 在一个「会话」内执行采集：会话期间所有 HTTP 请求走同一个出口 IP。
 * key 通常用 source.id，这样一家店铺全程同一 IP，店铺之间轮换。
 */
export function withProxySession<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!proxyPoolEnabled()) return fn();
  return session.run(key, fn);
}

/** 当前会话应使用的代理；未启用或不在会话中返回 null（走直连）。 */
export function currentProxy(): ProxyEntry | null {
  const pool = loadProxyPool();
  if (pool.length === 0) return null;
  const key = session.getStore();
  if (!key) return null;

  const assignedId = assignments.get(key);
  if (assignedId) {
    const found = pool.find((p) => p.id === assignedId);
    if (found) return found;
  }
  const usable = healthy(pool);
  const picked = usable[cursor % usable.length]!;
  cursor = (cursor + 1) % usable.length;
  assignments.set(key, picked.id);
  return picked;
}

// ---------------- 快代理私密代理（动态提取） ----------------
//
// 快代理私密代理按「IP 数量」计费：每次从提取接口拿到一个临时 IP（host:port），
// 有效时长约 1–5 分钟，期间流量不限。IP 失效后重新提取，扣一个新额度。
// 与上面的静态文件池不同：没有多出口轮换，而是全局复用当前提取到的那个 IP，
// 失效后再提下一个。「独享大陆住宅 IP」正是靠这种方式，低频采集时不触发
// 地域拒绝(denied by http_custom)与频率限流(denied by http_ratelimit)。

interface KdlConfig {
  secretId: string;
  signature: string;
  username: string;
  password: string;
}

function kdlConfig(): KdlConfig | null {
  const secretId = String(process.env.SHOP_PROXY_KDL_SECRET_ID ?? "").trim();
  const signature = String(process.env.SHOP_PROXY_KDL_SIGNATURE ?? "").trim();
  if (!secretId || !signature) return null;
  return {
    secretId,
    signature,
    username: String(process.env.SHOP_PROXY_KDL_USERNAME ?? "").trim(),
    password: String(process.env.SHOP_PROXY_KDL_PASSWORD ?? "").trim(),
  };
}

export function kdlProxyEnabled(): boolean {
  return kdlConfig() !== null;
}

/** 是否启用了任意代理源（静态文件池或快代理）。 */
export function proxyEnabled(): boolean {
  return proxyPoolEnabled() || kdlProxyEnabled();
}

let kdlEntry: ProxyEntry | null = null;

async function fetchKdlProxy(): Promise<ProxyEntry | null> {
  const cfg = kdlConfig();
  if (!cfg) return null;
  const url = new URL("https://dps.kdlapi.com/api/getdps/");
  url.searchParams.set("secret_id", cfg.secretId);
  url.searchParams.set("signature", cfg.signature);
  url.searchParams.set("num", "1");
  url.searchParams.set("format", "text");
  url.searchParams.set("sep", "1");
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  if (!text) return null;
  const [host, port] = text.split(":");
  if (!host || !port || !/^\d+$/.test(port)) return null;
  return makeEntry(host, port, cfg.username, cfg.password);
}

/**
 * 解析「当前该用的代理出口」：
 * 快代理动态模式返回缓存的临时 IP（没有则现场提取）；否则沿用静态池的会话粘性逻辑。
 */
export async function resolveCurrentProxy(): Promise<ProxyEntry | null> {
  if (kdlProxyEnabled()) {
    if (!kdlEntry) kdlEntry = await fetchKdlProxy();
    return kdlEntry;
  }
  return currentProxy();
}

/** 代理不可用（连不上 / 认证失败）：拉黑一段时间，并让当前会话改用下一个。 */
export function reportProxyFailure(entry: ProxyEntry): void {
  if (kdlEntry && kdlEntry.id === entry.id) {
    // 快代理临时 IP 失效：清空缓存，下次 resolveCurrentProxy 重新提取
    kdlEntry = null;
    const agent = agents.get(entry.id);
    if (agent) {
      agents.delete(entry.id);
      void agent.close().catch(() => {});
    }
    return;
  }
  cooldownUntil.set(entry.id, Date.now() + cooldownMs());
  const key = session.getStore();
  if (key && assignments.get(key) === entry.id) assignments.delete(key);
  const agent = agents.get(entry.id);
  if (agent) {
    agents.delete(entry.id);
    void agent.close().catch(() => {});
  }
}

const PROXY_ERROR_CODES = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPROTO|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/;

/**
 * 判断一个错误是否是「代理本身的问题」，而非目标站点的问题。
 *
 * undici 会把底层连接错误包成 TypeError("fetch failed")，真正的原因藏在 cause 里
 * （AggregateError 时还要再看 errors[]）。不展开就只能看到 "fetch failed"，
 * 会被误判成站点故障，坏掉的代理也就永远不会被摘掉。
 */
export function isProxyError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown, depth: number): boolean => {
    if (!e || depth > 4 || seen.has(e)) return false;
    seen.add(e);
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code ?? "";
    if (PROXY_ERROR_CODES.test(code)) return true;
    if (/\bproxy\b|407|tunnel|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(msg)) return true;
    const errors = (e as { errors?: unknown[] }).errors;
    if (Array.isArray(errors) && errors.some((x) => visit(x, depth + 1))) return true;
    return visit((e as { cause?: unknown }).cause, depth + 1);
  };
  return visit(err, 0);
}

// ---------------- 代理网关的预解析 ----------------
//
// 本机若开着 Clash/Surge 的 TUN + fake-ip，代理网关域名会被解析成 198.18.x.x 假地址，
// 连接随即被 TUN 层接管——进程设的代理形同虚设，且**不会报错**，测试结论会全错。
// 指定 SHOP_PROXY_DNS（如 1.1.1.1）可绕过系统解析器拿到网关真实 IP，直接按 IP 连。
// 服务器上没有 TUN，不需要开这个。

let resolver: Resolver | null = null;
const resolvedGateways = new Map<string, string>();

function proxyDns(): string {
  return String(process.env.SHOP_PROXY_DNS ?? "").trim();
}

/** 用指定 DNS 解析代理网关，把 entry 里的域名换成真实 IP。失败则原样返回。 */
export async function resolveGateway(entry: ProxyEntry): Promise<ProxyEntry> {
  const server = proxyDns();
  if (!server) return entry;
  const host = new URL(entry.server).hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return entry;

  let ip = resolvedGateways.get(host);
  if (!ip) {
    if (!resolver) {
      resolver = new Resolver();
      resolver.setServers([server]);
    }
    try {
      const [first] = await resolver.resolve4(host);
      if (!first || isPrivateAddress(first)) return entry;
      ip = first;
      resolvedGateways.set(host, ip);
    } catch {
      return entry;
    }
  }
  return { ...entry, server: entry.server.replace(host, ip), url: entry.url.replace(`@${host}:`, `@${ip}:`) };
}

// ---------------- undici dispatcher ----------------

const agents = new Map<string, ProxyAgent>();

export function dispatcherFor(entry: ProxyEntry): Dispatcher {
  let agent = agents.get(entry.id);
  if (!agent) {
    agent = new ProxyAgent({ uri: entry.url, connectTimeout: 15_000 });
    agents.set(entry.id, agent);
  }
  return agent;
}

/**
 * 供浏览器采集使用的 playwright proxy 配置。
 * 与 HTTP 采集共用同一会话出口，并同样做网关预解析——
 * Chrome 自己解析域名时一样会拿到 TUN 的假地址，表现为 ERR_TUNNEL_CONNECTION_FAILED。
 */
export async function playwrightProxy(): Promise<{ server: string; username?: string; password?: string } | undefined> {
  const entry = await resolveCurrentProxy();
  if (!entry) return undefined;
  const resolved = await resolveGateway(entry);
  return { server: resolved.server, username: resolved.username, password: resolved.password };
}
