import type { SqliteDatabase } from "../db/connection";
import { getSource, recentRunMessages, updateSource } from "../db/repo";

// 自动停用「确定性失效」的店铺。
//
// 每天定时全量采集，失效的店铺会一直被重复采：链动小铺还要为此消耗按个数计费的代理 IP，
// 失败记录也会把健康面板刷满，真正需要处理的问题反而被淹掉。
//
// 判定原则：**只停用不会自己恢复的**。403 / 5xx / 52x / 超时一律不算——那是风控或临时故障，
// 停用了就再也不会自己好起来，而这类错误恰恰是最常见的。

export type RetireReason = "shop_gone" | "endpoint_gone" | "empty";

const REASON_LABEL: Record<RetireReason, string> = {
  shop_gone: "店铺已不存在",
  endpoint_gone: "站点接口已下线",
  empty: "长期没有商品",
};

/**
 * 这条失败消息是不是「确定性失效」。是则返回原因，否则返回 null。
 *
 * 注意只认两类信号：站点明说店铺没了，或接口路径返回 404/410。
 * 403 看着也像"没了"，但它同时是风控和地域拒绝的表现（ldxp 全靠代理才绕开），
 * 把它算进来会在代理一抖动时把整批店铺停掉。
 */
export function permanentFailureReason(message: string | null | undefined): RetireReason | null {
  const msg = String(message ?? "");
  if (/店铺(?:链接)?不存在|店铺已(?:关闭|删除|下架|停用)|shop not found/i.test(msg)) return "shop_gone";
  if (/returned HTTP (?:404|410)\b/.test(msg)) return "endpoint_gone";
  return null;
}

/** 这一轮的结果是不是「采到 0 条」。 */
export function isEmptyRunMessage(message: string | null | undefined): boolean {
  return /^采集结果为空/.test(String(message ?? ""));
}

/**
 * 空店要连续多少轮才停用。0 = 关闭这条规则。
 *
 * 不能一轮就停：店主临时下架清仓、补货间隙都会采到 0 条，停用后不会自己恢复，
 * 用户得手动重新启用才发现。默认 7 轮 ≈ 日采一次跑满一周。
 */
export function emptyRoundsThreshold(): number {
  const raw = Number(process.env.SHOP_RETIRE_EMPTY_ROUNDS ?? 7);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(2, Math.floor(raw));
}

/** 接口 404/410 要连续失败多少次才停用。临时维护也会 404，一次就停太急。 */
export function goneFailureThreshold(): number {
  const raw = Number(process.env.SHOP_RETIRE_GONE_FAILURES ?? 2);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, Math.floor(raw));
}

/** 从最近一轮往前数，连续有多少轮是空结果。遇到非空立即停止。 */
export function leadingEmptyRuns(messages: (string | null)[]): number {
  let n = 0;
  for (const message of messages) {
    if (!isEmptyRunMessage(message)) break;
    n += 1;
  }
  return n;
}

/** 停用店铺，并把原因追加到 notes 最前面（保留用户原有备注）。 */
export function retireSource(db: SqliteDatabase, sourceId: string, reason: RetireReason, detail: string): string {
  const line = `[自动停用] ${REASON_LABEL[reason]}：${detail}`;
  const previous = String(getSource(db, sourceId)?.notes ?? "").trim();
  updateSource(db, sourceId, { enabled: false, notes: previous ? `${line}\n${previous}` : line });
  return line;
}

/**
 * 采集失败后判断是否该停用。
 * `consecutiveFailures` 用 markSourceFailure 的返回值，避免再查一次库。
 */
export function retireIfPermanentFailure(
  db: SqliteDatabase,
  sourceId: string,
  message: string,
  consecutiveFailures: number,
): string | null {
  const reason = permanentFailureReason(message);
  if (!reason) return null;
  // 店铺不存在是站点明确的业务答复，无需等；404 可能是临时维护，要连续几次才算数。
  if (reason === "endpoint_gone" && consecutiveFailures < goneFailureThreshold()) return null;
  return retireSource(db, sourceId, reason, message.slice(0, 160));
}

/**
 * 采集成功但结果为空时判断是否该停用。
 *
 * `currentMessage` 是本轮尚未落库的结果，与历史记录一起计数——**必须在写 crawl_run 之前调用**。
 * 这样停用那一轮的 crawl_run 记的是「[自动停用] …」而不是「采集结果为空」，
 * 连续计数就在此处断开：用户重新启用后能重新拿满一个完整周期，而不是再空一轮就立刻被停掉。
 */
export function retireIfLongEmpty(db: SqliteDatabase, sourceId: string, currentMessage: string | null): string | null {
  const threshold = emptyRoundsThreshold();
  if (threshold <= 0) return null;
  if (!isEmptyRunMessage(currentMessage)) return null;
  const rounds = leadingEmptyRuns([currentMessage, ...recentRunMessages(db, sourceId, threshold - 1)]);
  if (rounds < threshold) return null;
  return retireSource(db, sourceId, "empty", `连续 ${rounds} 轮采集结果为空`);
}
