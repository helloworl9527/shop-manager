import type { SqliteDatabase } from "../db/connection";
import { enqueueJob } from "./jobs";
import { kickScheduler } from "./scheduler";
import type { CollectDeps } from "./orchestrator";

/**
 * 进程内定时采集：按固定间隔入队一个全量任务。
 *
 * 不额外引入 cron 依赖——入队后由既有串行调度器执行，且 collection_jobs 的
 * `uq_jobs_active_all` 部分唯一索引保证「同时只有一个活动全量任务」，
 * 所以即使上一轮还没跑完，这里也只会拿到已存在的任务，不会堆积。
 */

const MIN_INTERVAL_MINUTES = 5;

/** 定时间隔（毫秒）；返回 0 表示未启用。 */
export function collectIntervalMs(): number {
  const raw = Number(process.env.SHOP_COLLECT_INTERVAL_MINUTES ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // 下限保护：间隔过小会把同一批站点反复打到限流/封 IP。
  return Math.max(MIN_INTERVAL_MINUTES, Math.floor(raw)) * 60_000;
}

export interface ScheduledCollectionHandle {
  enabled: boolean;
  intervalMs: number;
  stop: () => void;
}

/** 启动定时采集。返回句柄；未配置间隔时 enabled=false 且不注册定时器。 */
export function startScheduledCollection(
  db: SqliteDatabase,
  deps: CollectDeps & { concurrency?: number } = {},
  log: (msg: string) => void = console.log,
): ScheduledCollectionHandle {
  const intervalMs = collectIntervalMs();
  if (!intervalMs) return { enabled: false, intervalMs: 0, stop: () => {} };

  const tick = () => {
    try {
      const r = enqueueJob(db, { jobType: "all", requestedBy: "cron" });
      if (r.created) {
        log(`定时采集：已入队全量任务 ${r.jobId}`);
        kickScheduler(db, deps);
      } else {
        log("定时采集：上一轮仍在进行，本次跳过");
      }
    } catch (err) {
      // 定时器内异常若不吞掉会终止整个进程，这里记录后等待下一轮。
      log(`定时采集入队失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (process.env.SHOP_COLLECT_ON_START === "1") tick();

  return { enabled: true, intervalMs, stop: () => clearInterval(timer) };
}
