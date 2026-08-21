import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/connection";
import { nowIso, getSource, listEnabledSources, recomputeShadowedOffers } from "../db/repo";
import { collectSource, runAllSources, type CollectDeps, type SourceResult, type RunAllResult } from "./orchestrator";

export interface EnqueueResult {
  jobId: string;
  created: boolean;
  note?: string;
}

const activeAllId = (db: SqliteDatabase): string | undefined =>
  (db.prepare("SELECT id FROM collection_jobs WHERE job_type='all' AND status IN ('pending','running') LIMIT 1").get() as { id: string } | undefined)?.id;

const activeSourceId = (db: SqliteDatabase, sourceId: string): string | undefined =>
  (db.prepare("SELECT id FROM collection_jobs WHERE source_id=? AND status IN ('pending','running') LIMIT 1").get(sourceId) as { id: string } | undefined)?.id;

/**
 * 入队采集任务，DB 级防重 + 全量/单源互斥（方案 §4.6 / T3）：
 *  - 有活动全量任务时，新单源任务直接复用该全量 jobId；
 *  - 靠部分唯一索引拒绝重复活动任务，冲突时返回已存在的活动任务（幂等）。
 */
export function enqueueJob(
  db: SqliteDatabase,
  opts: { jobType: "all" | "source"; sourceId?: string | null; requestedBy?: string },
): EnqueueResult {
  if (opts.jobType === "source") {
    if (!opts.sourceId) throw new Error("单源任务需要 sourceId。");
    const coveringAll = activeAllId(db);
    if (coveringAll) return { jobId: coveringAll, created: false, note: "covered-by-active-all" };
  }

  const id = randomUUID();
  const at = nowIso();
  const source = opts.sourceId ? getSource(db, opts.sourceId) : undefined;
  try {
    db.prepare(
      `INSERT INTO collection_jobs (id, job_type, source_id, source_name, status, requested_by, created_at, updated_at)
       VALUES (@id, @type, @src, @srcName, 'pending', @by, @at, @at)`,
    ).run({ id, type: opts.jobType, src: opts.sourceId ?? null, srcName: source?.name ?? null, by: opts.requestedBy ?? "cli", at });
    return { jobId: id, created: true };
  } catch (err) {
    const existing = opts.jobType === "all" ? activeAllId(db) : activeSourceId(db, opts.sourceId!);
    if (existing) return { jobId: existing, created: false, note: "already-active" };
    throw err;
  }
}

export interface JobRunResult {
  jobId: string;
  jobType: string;
  status: string;
  all?: RunAllResult;
  source?: SourceResult;
}

/** 执行一个任务（串行调度器的最小单元）。 */
export async function runJob(db: SqliteDatabase, jobId: string, deps: CollectDeps & { concurrency?: number } = {}): Promise<JobRunResult> {
  const job = db.prepare("SELECT id, job_type, source_id FROM collection_jobs WHERE id=?").get(jobId) as
    | { id: string; job_type: string; source_id: string | null }
    | undefined;
  if (!job) throw new Error(`任务不存在：${jobId}`);

  db.prepare("UPDATE collection_jobs SET status='running', started_at=@at, attempts=attempts+1, updated_at=@at WHERE id=@id").run({ id: jobId, at: nowIso() });

  // 一个源的写入会改变另一个源的遮蔽结果（同一商品链接谁更新），所以按任务整体重算一次，
  // 而不是每采完一个源都重算——后者一轮全量要跑 50 多次，纯属浪费。
  const settle = () => {
    try {
      recomputeShadowedOffers(db);
    } catch {
      // 去重只影响展示，算不出来也不该让整个任务判失败
    }
  };

  try {
    if (job.job_type === "all") {
      const r = await runAllSources(db, listEnabledSources(db), deps);
      settle();
      const problemSummary = {
        failedSources: r.failedSources,
        partialSources: r.partialSources,
        manualRequiredSources: r.manualRequiredSources,
        skippedSources: r.skippedSources,
      };
      const hasProblems = Object.values(problemSummary).some((sourceIds) => sourceIds.length > 0);
      finishJob(db, jobId, r.status, hasProblems ? JSON.stringify(problemSummary) : null);
      return { jobId, jobType: "all", status: r.status, all: r };
    }

    const source = job.source_id ? getSource(db, job.source_id) : undefined;
    if (!source) {
      finishJob(db, jobId, "failed", "店铺不存在或已删除");
      return { jobId, jobType: "source", status: "failed" };
    }
    const res = await collectSource(db, source, deps);
    settle();
    const jobStatus = res.status === "skipped" ? "failed" : res.status; // success/partial/failed
    finishJob(db, jobId, jobStatus, res.message ?? null);
    return { jobId, jobType: "source", status: jobStatus, source: res };
  } catch (err) {
    finishJob(db, jobId, "failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function finishJob(db: SqliteDatabase, jobId: string, status: string, lastError: string | null): void {
  db.prepare("UPDATE collection_jobs SET status=@s, finished_at=@at, last_error=@err, updated_at=@at WHERE id=@id")
    .run({ id: jobId, s: status, at: nowIso(), err: lastError });
}
