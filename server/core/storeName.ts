import type { CollectorTarget } from "../collectors/types";
import { fetchShopApiStoreName } from "../collectors/shopApi";
import { httpClient, type HttpClient } from "./http";
import { isLiandongSource, withProxySession } from "./proxy";
import { isWeakSourceName, normalizeSourceUrl, resolveStoreName } from "./sourceProbe";

export type StoreNameVia = "direct" | "proxy" | "fallback";

export interface StoreNameResult {
  /** 规范化后的入口链接 */
  url: string;
  name: string;
  via: StoreNameVia;
}

/**
 * 只探测店铺名，不采集商品。给「收藏店铺链接」用。
 *
 * 先直连读页面（一个请求，够绝大多数站点用）。链动小铺是例外：它的页面是 SPA、
 * `<title>` 为空，直连只能退化成「域名 / token」，真名只在 shopApi 接口里，而
 * `pay.ldxp.cn` 的这个接口必须走大陆出口。所以**仅当直连退化、且这条链接确实是
 * 链动小铺时**，才额外走一次代理去取真名——代理 IP 有几分钟缓存、收藏又是低频手动
 * 操作，实际几乎不增加按个数计费的 IP 消耗。
 */
export async function probeStoreName(
  rawUrl: string,
  deps: { http?: HttpClient } = {},
): Promise<StoreNameResult> {
  const normalized = normalizeSourceUrl(rawUrl);
  const http = deps.http ?? httpClient;
  const target: CollectorTarget = {
    sourceId: "favorite-store",
    sourceName: "",
    sourceUrl: normalized.entryUrl,
    baseUrl: normalized.baseUrl,
    knownItemUrls: normalized.knownItemUrls,
  };

  // resolveStoreName 内部吞掉网络异常并退化为「域名 / token」，这里不必再包 try。
  const direct = await withProxySession(() => resolveStoreName(target, http), { useProxy: false });
  if (!isWeakSourceName(direct, normalized.entryUrl)) {
    return { url: normalized.entryUrl, name: direct, via: "direct" };
  }

  if (isLiandongSource({ entryUrl: normalized.entryUrl })) {
    const viaApi = await withProxySession(() => fetchShopApiStoreName(target, http), { useProxy: true })
      .catch(() => null);
    if (viaApi && !isWeakSourceName(viaApi, normalized.entryUrl)) {
      return { url: normalized.entryUrl, name: viaApi, via: "proxy" };
    }
  }

  return { url: normalized.entryUrl, name: direct, via: "fallback" };
}
