import type { HttpClient } from "../core/http";

export type CollectorKind =
  | "auto"
  | "kami"
  | "dujiao"
  | "dujiaoHtml"
  | "shopApi"
  | "xiaoheiwan"
  | "opensoraHtml"
  | "makerichHtml"
  | "beibeiHtml"
  | "ikunloveApi"
  | "getgptApi"
  | "publicProductsApi"
  | "productsListApi"
  | "shopUserProductsApi"
  | "unicornHtml"
  | "mooncakeCatalog"
  | "blackcatWholesale"
  | "genericHtml"
  | "browser"
  | "pending"
  | "unsupported";

/** 采集目标（来自 sources 表的一行 + 衍生字段）。 */
export interface CollectorTarget {
  sourceId: string;
  sourceName: string;
  sourceUrl: string; // entry_url
  baseUrl: string; // 由 entry_url 推导的 origin
  sourceStoreName?: string;
  /** 已知商品链接（shopApi 反查 token 用，可选）。 */
  knownItemUrls?: string[];
}

/** 采集器统一输出。 */
export interface CollectorOffer {
  sourceTitle: string;
  price: number | null;
  status: string; // in_stock / low_stock / out_of_stock
  url: string;
  tags: string[];
  stockCount: number | null;
  /** 定性库存文本（如「非常多」「充足」），源站不给数字时保留原文用于展示。 */
  stockText?: string | null;
  currency?: string;
  sourceStoreName?: string;
  /** 外部商品键（含 SKU/variant），写库时作为 offer_id 的首选去重维度。 */
  externalKey?: string | null;
}

export type Collector = (target: CollectorTarget, http: HttpClient) => Promise<CollectorOffer[]>;

export interface DetectResult {
  kind: CollectorKind;
  evidence: string;
  offers?: CollectorOffer[];
  attempts?: ProbeAttempt[];
}

export interface ProbeAttempt {
  step: string;
  ok: boolean;
  ms: number;
  message?: string;
}
