import type { SqliteDatabase } from "../db/connection";
import { runJob } from "./jobs";
import type { CollectDeps } from "./orchestrator";
import { nowIso } from "../db/repo";

/**
 * 进程内串行调度器（单写者）：保证一次只跑一个 job，按入队顺序处理。
 * 后端唯一写库进程，避免多 job 并行写竞争。
 */
let current: Promise<void> | null = null;

async function pump(db: SqliteDatabase, deps: CollectDeps & { concurrency?: number }): Promise<void> {
  for (;;) {
    const next = db
      .prepare("SELECT id FROM collection_jobs WHERE status='pending' ORDER BY created_at, id LIMIT 1")
      .get() as { id: string } | undefined;
    if (!next) break;
    try {
      await runJob(db, next.id, deps);
    } catch {
      // runJob 内部已把任务标记 failed；继续处理下一个
    }
  }
}

function startPump(db: SqliteDatabase, deps: CollectDeps & { concurrency?: number }): Promise<void> {
  if (!current) current = pump(db, deps).finally(() => { current = null; });
  return current;
}

/** 触发调度（不阻塞）。入队后调用。 */
export function kickScheduler(db: SqliteDatabase, deps: CollectDeps & { concurrency?: number } = {}): void {
  void startPump(db, deps);
}

/** 等待把当前所有 pending 任务跑完（CLI/测试用）。会等待正在进行中的 pump。 */
export async function drainJobs(db: SqliteDatabase, deps: CollectDeps & { concurrency?: number } = {}): Promise<void> {
  await startPump(db, deps);
}

/** 服务启动时的崩溃恢复：清理过期源锁 + 把僵尸 running 任务标 failed。 */
export function recoverOnStartup(db: SqliteDatabase): { clearedLocks: number; failedJobs: number } {
  const at = nowIso();
  // 进程刚启动时不存在"正在进行中的采集"，把所有源锁清掉——
  // 包括被上一轮挂死/被杀进程心跳续租到未来的锁，否则那个源会一直卡住。
  const clearedLocks = db
    .prepare(
      `UPDATE sources SET collector_lock_owner=NULL, collector_lock_until=NULL, collector_lock_started_at=NULL
       WHERE collector_lock_until IS NOT NULL`,
    )
    .run().changes;
  // 进程重启后不可能还有真正 running 的任务 → 全部标 failed（可重试由用户再次触发）
  const failedJobs = db
    .prepare(
      `UPDATE collection_jobs SET status='failed', last_error='进程重启中断', finished_at=@at, updated_at=@at
       WHERE status='running'`,
    )
    .run({ at }).changes;
  return { clearedLocks, failedJobs };
}
