import { AsyncLocalStorage } from "node:async_hooks";
import { Resolver } from "node:dns/promises";
import { ProxyAgent, type Dispatcher } from "undici";
import { isPrivateAddress } from "./http";

// 出口 IP 代理。
//
// 只解决一个问题：链动小铺（shopApi）挂在阿里云 ESA 后面，对本机的境外出口返回
// 地域拒绝（denied by http_custom）、频率限流（denied by http_ratelimit）或滑块验证页。
// 换成大陆住宅出口才放行。其余站点（卡网/独角数卡/纯前端渲染站）本机直连一样采得到。
//
// 代理按 IP 个数计费，所以判定「谁该用代理」是这个模块的核心职责，见 isLiandongSource。

export interface ProxyEntry {
  id: string;
  /** 给 undici / playwright 用的完整地址，形如 http://host:port */
  server: string;
  username?: string;
  password?: string;
  /** 含认证信息的完整 URL，仅内部构造 ProxyAgent 用 */
  url: string;
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

// ---------------- 谁该用代理 ----------------
//
// 50 家店铺里只有链动小铺这一类需要大陆出口。让其余店铺也走代理纯属烧额度，
// 故按店铺类型分流：链动小铺走代理，其余一律直连本机出口。

/** 链动小铺的 URL 形态：/shop/<token> 或 /item/<key>。与 detectCollector 的强信号判定同源。 */
const LIANDONG_URL_SHAPE = /\/(shop|item)\/[^/?#]+/;

/**
 * 这家店铺是不是链动小铺（即是否该走代理）。
 *
 * 已定型的店铺看 collector_kind（前台显示为「链动小铺」的就是 shopApi）；
 * kind 还是 auto/空的新店铺看 URL 形态——detectCollector 遇到这个形态同样是直接判为
 * shopApi，所以这不是猜测，而是提前套用同一条规则。少了这一支，新加的链动小铺
 * 第一轮探测会直连撞上风控，被记成 failing，等于代理白配了。
 */
export function isLiandongSource(source: { collectorKind?: string | null; entryUrl?: string | null }): boolean {
  const kind = String(source.collectorKind ?? "").trim();
  if (kind === "shopApi") return true;
  if (kind && kind !== "auto") return false;
  return LIANDONG_URL_SHAPE.test(String(source.entryUrl ?? ""));
}

// ---------------- 采集会话 ----------------

/** 一次采集会话的上下文。目前只带「本次是否走代理」这一个决定。 */
interface ProxySession {
  useProxy: boolean;
}

const session = new AsyncLocalStorage<ProxySession>();

/**
 * 在一个「会话」内执行采集：会话期间的 HTTP 请求与浏览器采集共用同一出口决定。
 *
 * 同一家店铺的 HTTP 与风控回退后的浏览器必须走同一出口——中途换 IP，站点侧看到的是
 * 「同一会话换了 IP」，比不用代理更可疑。
 */
export function withProxySession<T>(fn: () => Promise<T>, opts: { useProxy: boolean }): Promise<T> {
  if (!proxyEnabled()) return fn();
  return session.run({ useProxy: opts.useProxy }, fn);
}

/**
 * 当前是否该走代理。**会话之外一律 false**（直连）。
 *
 * 这是刻意的默认值：漏包会话最多是某处直连，代价可控；反过来默认走代理，
 * 任何一处没走会话的请求都会静默地提一个计费 IP。
 */
export function proxySessionActive(): boolean {
  return session.getStore()?.useProxy === true;
}

// ---------------- 快代理私密代理（动态提取） ----------------
//
// 快代理私密代理按「IP 数量」计费：每次从提取接口拿到一个临时 IP（host:port），
// 有效时长约 1–5 分钟，期间流量不限。IP 失效后重新提取，扣一个新额度。
// 全局复用当前提取到的那个 IP，失效后再提下一个。「独享大陆住宅 IP」正是靠这种方式，
// 低频采集时不触发地域拒绝(denied by http_custom)与频率限流(denied by http_ratelimit)。

interface KdlConfig {
  secretId: string;
  signature: string;
  username: string;
  password: string;
}

function kdlConfig(): KdlConfig | null {
  if (process.env.SHOP_PROXY_ENABLED === "0") return null;
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

/** 是否配置了代理。未配置时全部店铺直连，采集行为与加代理前完全一致。 */
export function proxyEnabled(): boolean {
  return kdlConfig() !== null;
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
  // 提取接口异常时可能回吐内网/环回地址，放行就等于让代理成为访问内网的跳板。
  if (isPrivateAddress(host)) return null;
  return makeEntry(host, port, cfg.username, cfg.password);
}

/**
 * 解析「当前该用的代理出口」：本会话不走代理（非链动小铺）或未配置代理时返回 null（直连）。
 * 否则返回缓存的临时 IP，没有就现场提取一个。
 */
export async function resolveCurrentProxy(): Promise<ProxyEntry | null> {
  if (!proxySessionActive()) return null;
  if (!kdlEntry) kdlEntry = await fetchKdlProxy();
  return kdlEntry;
}

/** 代理不可用（连不上 / 认证失败 / 临时 IP 到期）：清掉缓存，下次重新提取。 */
export function reportProxyFailure(entry: ProxyEntry): void {
  if (kdlEntry && kdlEntry.id !== entry.id) return;
  kdlEntry = null;
  const agent = agents.get(entry.id);
  if (agent) {
    agents.delete(entry.id);
    void agent.close().catch(() => {});
  }
}

/** 测试与配置变更后重置内部状态。 */
export function resetProxyState(): void {
  kdlEntry = null;
  for (const agent of agents.values()) void agent.close().catch(() => {});
  agents.clear();
  resolvedGateways.clear();
  resolver = null;
}

const PROXY_ERROR_CODES = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPROTO|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/;

/**
 * 判断一个错误是否是「代理本身的问题」，而非目标站点的问题。
 *
 * undici 会把底层连接错误包成 TypeError("fetch failed")，真正的原因藏在 cause 里
 * （AggregateError 时还要再看 errors[]）。不展开就只能看到 "fetch failed"，
 * 会被误判成站点故障，过期的临时 IP 也就永远不会被换掉。
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
