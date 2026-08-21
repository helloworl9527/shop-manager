import type { Collector, CollectorOffer, CollectorTarget } from "./types";
import type { HttpClient } from "../core/http";
import { cleanText, numberOrNull, compact, isNonComparableTitle, statusFromStock } from "./util";
import { priceaiStoreIdentity } from "./priceaiApi";

// aihaotan.com（AI号探）的公开聚合接口。和 priceai 一样是别人采好的报价快照，
// 但只收录链动小铺——正是本机直采要靠代理才能过的那批，所以直连采它等于白捡覆盖面。
//
// 三个必须处理的接口特性：
//  1. limit 硬顶 96（填 500 也只返回 96 条），全量约 1.15 万条 = 120 多次翻页。
//     好在 offset 没有上限（priceai 是 5000），不必按平台分片。
//  2. **只收录有货商品**（实测 1.15 万条 stock 全部 >= 1，没有一条零库存）。
//     所以商品从列表消失可能是卖光、也可能是下架，两者分不开。这正好对上
//     delistMissing 的语义：标 hidden + out_of_stock，「再次返回自动恢复」，不做死亡判定。
//  3. 它是快照（updateTime 为天粒度），不是实时库存。实测比我们隔夜的直采数据更新，
//     但仍可能落后于源站，所以只当广度补充，不覆盖直采。

const PAGE_SIZE = 96;
/** 单次采集的总条数上限，防止对方数据量暴涨时把一轮采集拖垮。 */
const MAX_ROWS = 24_000;
/** 翻页上限，等价于 MAX_ROWS，避免对方分页异常时死循环。 */
const MAX_PAGES = 260;

interface AihaotanGoods {
  guid?: string;
  key?: string;
  shopKey?: string;
  title?: string;
  shopName?: string;
  shopUrl?: string;
  linkUrl?: string;
  price?: number | null;
  stock?: number | null;
  updateTime?: string;
}

interface AihaotanShop {
  key?: string;
  name?: string;
  platform?: string;
}

function api(base: string, path: string, params: Record<string, string | number>): string {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

/**
 * 店铺 key → 平台标识。商品接口本身不给 platform，只能从 /api/shops 补。
 * 取不到就返回空 Map：平台标签只是喂给 classifyOffer 的辅助信息，缺了不影响采集。
 */
async function discoverShopPlatforms(base: string, http: HttpClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const rows: AihaotanShop[] = await http.fetchJson(api(base, "/api/shops", {}));
    if (!Array.isArray(rows)) return map;
    for (const row of rows) {
      const key = String(row?.key ?? "").trim().toLowerCase();
      const platform = cleanText(String(row?.platform ?? ""));
      if (key && platform) map.set(key, platform);
    }
  } catch {
    // 忽略：没有平台标签照样能采
  }
  return map;
}

function offerFromGoods(row: AihaotanGoods, platforms: Map<string, string>): CollectorOffer | null {
  const title = cleanText(row?.title ?? "");
  const price = numberOrNull(row?.price);
  const url = String(row?.linkUrl ?? "").trim();
  if (!title || price === null || !url || isNonComparableTitle(title)) return null;

  // 这里可以放心用 statusFromStock 二次推断（priceai 那边不行）：
  // 对方给的是真实库存数字，不存在「无限库存记 0」的情况，实测最小值就是 1。
  const stockCount = numberOrNull(row?.stock);

  return {
    sourceTitle: title,
    price,
    status: statusFromStock(stockCount),
    stockCount,
    // 保留原店铺名，前台的「在售家数」才不会把几百家店算成一家。
    // 用 || 而不是 ??：空串必须落到 undefined，否则上层 COALESCE 拿到空店名，
    // 几百家店会塌成我们自己的源名。
    sourceStoreName: cleanText(row?.shopName ?? "") || undefined,
    url,
    // 用商品链接当外部键，不用对方的 guid：那是它快照里的标识，跨快照是否稳定无从保证，
    // 一漂移就会整批下架再整批新增。linkUrl 里的 /item/<key> 是链动小铺的真实商品键，稳定。
    externalKey: null,
    tags: compact([platforms.get(String(row?.shopKey ?? "").trim().toLowerCase()) ?? null]),
  };
}

export const collectAihaotanApi: Collector = async (target: CollectorTarget, http) => {
  const base = target.baseUrl;
  const platforms = await discoverShopPlatforms(base, http);

  // 跳过本机已直采的店铺：那批数据我们采得更全更新，重复收录会让同一家店在
  // 比价页出现两次、「在售家数」也跟着虚高。
  // knownStoreUrls 传进来的是本机 sources 的原始入口 URL，必须换算成同一套身份格式再比，
  // 否则拿 URL 去比对身份串永远不相等——去重会静默失效。
  const skip = new Set((target.knownStoreUrls ?? []).map((url) => priceaiStoreIdentity(url, url)));

  const offers: CollectorOffer[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (offers.length >= MAX_ROWS) break;
    const payload = await http.fetchJson(api(base, "/api/goods", { limit: PAGE_SIZE, offset: page * PAGE_SIZE, sortBy: "price_asc" }));
    const batch: AihaotanGoods[] = Array.isArray(payload) ? payload : [];
    for (const row of batch) {
      const identity = priceaiStoreIdentity(String(row?.shopUrl ?? ""), String(row?.linkUrl ?? ""));
      if (skip.has(identity)) continue;
      const offer = offerFromGoods(row, platforms);
      if (!offer) continue;
      // 翻页期间对方数据会轻微漂移，同一条可能在两页里各出现一次，这里兜一下
      if (seen.has(offer.url)) continue;
      seen.add(offer.url);
      offers.push(offer);
    }
    // 不足一页 = 已翻到底；对方超出总量时返回空数组
    if (batch.length < PAGE_SIZE) break;
  }
  return offers;
};
