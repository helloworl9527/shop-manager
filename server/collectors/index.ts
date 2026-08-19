import type { Collector, CollectorKind, CollectorTarget } from "./types";
import type { HttpClient } from "../core/http";
import { collectKami } from "./kami";
import { collectDujiao } from "./dujiao";
import { collectDujiaoHtml } from "./dujiaoHtml";
import { collectShopApi } from "./shopApi";
import { collectPublicProductsApi } from "./publicProductsApi";
import { collectProductsListApi } from "./productsListApi";
import { collectGenericHtml } from "./genericHtml";
import { collectBrowser } from "./browser";
import { detectCollector, inferCollectorKind } from "./registry";

/** M2 阶段 A 已实现的采集器。 */
const COLLECTORS: Partial<Record<CollectorKind, Collector>> = {
  kami: collectKami,
  dujiao: collectDujiao,
  dujiaoHtml: collectDujiaoHtml,
  shopApi: collectShopApi,
  publicProductsApi: collectPublicProductsApi,
  productsListApi: collectProductsListApi,
  genericHtml: collectGenericHtml,
  browser: collectBrowser,
};

/** 阶段 B 已知但尚未移植的类型（遇到时显式报「暂不支持」，不当作错误源）。 */
const PENDING_KINDS: CollectorKind[] = [
  "xiaoheiwan", "opensoraHtml", "makerichHtml", "beibeiHtml", "ikunloveApi", "getgptApi",
  "shopUserProductsApi", "unicornHtml", "mooncakeCatalog", "blackcatWholesale",
  "pending",
];

export class UnsupportedCollectorError extends Error {
  constructor(kind: string) {
    super(`采集器类型暂不支持：${kind}`);
    this.name = "UnsupportedCollectorError";
  }
}

export class PendingCollectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingCollectorError";
  }
}

/**
 * 解析采集器。kind='auto' 时按域名嗅探；阶段 B 类型与未知类型抛 UnsupportedCollectorError。
 */
export function collectorFor(kind: CollectorKind | string | null | undefined, hostOrUrl = ""): Collector {
  let resolved = (kind ?? "auto") as CollectorKind;
  if (resolved === "auto") {
    resolved = inferCollectorKind(hostOrUrl) ?? ("unsupported" as CollectorKind);
  }
  const collector = COLLECTORS[resolved];
  if (collector) return collector;
  if (resolved === "pending") throw new PendingCollectorError("采集器待办：未命中已实现采集器，请人工确认或等待后续采集器。");
  if (PENDING_KINDS.includes(resolved) || resolved === "unsupported") {
    throw new UnsupportedCollectorError(resolved);
  }
  throw new UnsupportedCollectorError(String(kind));
}

/**
 * 解析最终采集器类型：显式类型直接用；`auto` 先按域名注册表，再实地探测接口形态，
 * 都不中才判 unsupported。让 auto 对任意卡网/独角/链动小铺站点通用。
 */
export async function resolveCollectorKind(
  kind: CollectorKind | string | null | undefined,
  target: CollectorTarget,
  http: HttpClient,
): Promise<CollectorKind> {
  const k = (kind ?? "auto") as CollectorKind;
  if (k !== "auto") return k;
  return (await detectCollector(target, http)).kind;
}

export { COLLECTORS, PENDING_KINDS, detectCollector };
