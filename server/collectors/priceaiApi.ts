import type { Collector, CollectorOffer, CollectorTarget } from "./types";
import type { HttpClient } from "../core/http";
import { cleanText, numberOrNull, compact, isNonComparableTitle, normalizeHostname, shopTokenFromUrl } from "./util";

// priceai.cc 的公开聚合接口。它本身不是一家店铺，而是别人采好的**几百家店铺**的报价快照，
// 其中约九成来自链动小铺（pay.ldxp.cn）——正是本机直采要靠代理才能过的那批。
// 所以这个源的价值是「广度」：我们自己只直采了二十来家链动小铺，它收录了四百多家。
//
// 两个必须处理的接口约束：
//  1. offset 上限 5000，而总量已超过 6500 → 必须按 platform 分片扫，各片都远低于上限。
//  2. 它是快照（CDN 缓存约 5 分钟），不是实时库存，所以 status 只能照抄，不做二次判断。

const PAGE_SIZE = 200;
/** 单次采集的总条数上限，防止对方数据量暴涨时把一轮采集拖垮。 */
const MAX_ROWS = 20_000;
/** 分片内的翻页上限，等价于对方 offset 5000 的约束，避免死循环。 */
const MAX_PAGES_PER_SLICE = 30;

interface PriceaiOffer {
  id?: string;
  url?: string;
  shopUrl?: string;
  sourceTitle?: string;
  sourceStoreName?: string;
  sourceName?: string;
  price?: number | null;
  status?: string;
  stockCount?: number | null;
  tags?: unknown;
}

interface PriceaiRow {
  offer?: PriceaiOffer;
  product?: { platform?: string; productType?: string; spec?: string };
}

function api(base: string, path: string, params: Record<string, string | number>): string {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

/**
 * 平台枚举是动态的，从 /api/merchants 汇总而来——写死一份的话，对方新增平台我们就静默漏采。
 * 取不到就返回空数组，调用方退回不分片的单次扫描（能拿到前 5000 条）。
 */
async function discoverPlatforms(base: string, http: HttpClient): Promise<string[]> {
  const platforms = new Set<string>();
  for (let offset = 0; offset < 600; offset += PAGE_SIZE) {
    let payload: any;
    try {
      payload = await http.fetchJson(api(base, "/api/merchants", { limit: PAGE_SIZE, offset }));
    } catch {
      break;
    }
    const rows: any[] = Array.isArray(payload?.rows) ? payload.rows : [];
    for (const row of rows) for (const p of row?.platforms ?? []) if (p) platforms.add(String(p));
    if (rows.length < PAGE_SIZE) break;
  }
  return [...platforms];
}

/**
 * 店铺身份：可注册域名 + /shop/<token>（小写）。用于跳过我们自己已直采的店铺。
 *
 * 取**末两段域名**而不是完整 host，是因为两边的子域根本对不上：我们库里的入口是
 * `pay.ldxp.cn/shop/2VWX76A4`，priceai 的 shopUrl 却是 `www.ldxp.cn/shop/2vwx76a4`。
 * 只剥 www. 的话这两条永远不相等，去重就形同虚设。
 */
function storeIdentity(shopUrl: string, itemUrl: string): string {
  const host = normalizeHostname(shopUrl || itemUrl).replace(/^www\./, "");
  const parts = host.split(".");
  const domain = parts.length > 2 ? parts.slice(-2).join(".") : host;
  const token = shopTokenFromUrl(shopUrl || itemUrl) ?? "";
  return `${domain}|${token.toLowerCase()}`;
}

function offerFromRow(row: PriceaiRow): CollectorOffer | null {
  const offer = row?.offer;
  if (!offer) return null;
  const title = cleanText(offer.sourceTitle ?? "");
  const price = numberOrNull(offer.price);
  const url = String(offer.url ?? "").trim();
  if (!title || price === null || !url || isNonComparableTitle(title)) return null;

  // 状态照抄快照，不用 statusFromStock 二次推断：对方已经做过判断，
  // 而 stockCount 在无限库存的商品上可能是 0 或缺失，重算反而会误判成缺货。
  const status = offer.status === "out_of_stock" ? "out_of_stock" : offer.status === "low_stock" ? "low_stock" : "in_stock";

  return {
    sourceTitle: title,
    price,
    status,
    stockCount: numberOrNull(offer.stockCount),
    // 保留原店铺名，前台的「在售家数」才不会把几百家店算成一家。
    // 用 || 而不是 ??：sourceStoreName 为空串时必须落到 sourceName，否则这条报价没有店铺名，
    // 上层 COALESCE 会回退成我们自己的源名，几百家店就塌成一家。
    sourceStoreName: cleanText(offer.sourceStoreName || offer.sourceName || "") || undefined,
    url,
    // 用商品链接当外部键（实测同一分片内 url 唯一）。不用对方的 offer.id：
    // 那是它自己快照里的标识，跨快照是否稳定无从保证，一漂移就会整批下架再整批新增。
    externalKey: null,
    tags: compact([
      row.product?.platform ?? null,
      row.product?.productType ?? null,
      row.product?.spec ?? null,
      ...(Array.isArray(offer.tags) ? offer.tags.map((t) => cleanText(String(t))) : []),
    ]),
  };
}

/** 扫一个分片（platform 为空表示不分片），返回该片的全部行。 */
async function sweep(base: string, http: HttpClient, platform: string | null, budget: () => number): Promise<PriceaiRow[]> {
  const rows: PriceaiRow[] = [];
  for (let page = 0; page < MAX_PAGES_PER_SLICE; page += 1) {
    if (budget() <= 0) break;
    const params: Record<string, string | number> = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (platform) params.platform = platform;
    const payload = await http.fetchJson(api(base, "/api/offers", params));
    const batch: PriceaiRow[] = Array.isArray(payload?.rows) ? payload.rows : [];
    rows.push(...batch);
    // rows 不足一页 = 该分片已扫完；limited=false 同理。超过 offset 上限时对方返回空数组。
    if (batch.length < PAGE_SIZE || payload?.limited === false) break;
  }
  return rows;
}

export const collectPriceaiApi: Collector = async (target: CollectorTarget, http) => {
  const base = target.baseUrl;
  const platforms = await discoverPlatforms(base, http);
  const slices: (string | null)[] = platforms.length ? platforms : [null];

  const rawRows: PriceaiRow[] = [];
  for (const platform of slices) {
    rawRows.push(...(await sweep(base, http, platform, () => MAX_ROWS - rawRows.length)));
    if (rawRows.length >= MAX_ROWS) break;
  }

  // 跳过本机已直采的店铺：那批数据我们采得更全更新，重复收录会让同一家店在
  // 比价页出现两次、「在售家数」也跟着虚高。
  // knownStoreUrls 传进来的是本机 sources 的原始入口 URL，必须换算成同一套身份格式再比，
  // 否则拿 URL 去比对身份串永远不相等——去重会静默失效。
  const skip = new Set((target.knownStoreUrls ?? []).map((url) => storeIdentity(url, url)));
  const offers: CollectorOffer[] = [];
  const seen = new Set<string>();
  for (const row of rawRows) {
    const identity = storeIdentity(String(row?.offer?.shopUrl ?? ""), String(row?.offer?.url ?? ""));
    if (skip.has(identity)) continue;
    const offer = offerFromRow(row);
    if (!offer) continue;
    // 分片之间理论上不重叠，但对方若把一条报价归进两个平台，这里兜一下
    if (seen.has(offer.url!)) continue;
    seen.add(offer.url!);
    offers.push(offer);
  }
  return offers;
};

export { storeIdentity as priceaiStoreIdentity };
