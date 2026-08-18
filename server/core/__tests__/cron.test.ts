import { describe, it, expect, afterEach } from "vitest";
import { openDatabase } from "../../db/connection";
import { applySchema, seedCanonicalProducts } from "../../db/init";
import { upsertSource } from "../../db/repo";
import { enqueueJob } from "../jobs";
import { drainJobs } from "../scheduler";
import { collectIntervalMs, startScheduledCollection } from "../cron";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function db() {
  const d = openDatabase(":memory:");
  applySchema(d);
  seedCanonicalProducts(d);
  upsertSource(d, { id: "s1", name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" });
  return d;
}

describe("定时采集间隔", () => {
  it("未配置或非法值 → 不启用", () => {
    delete process.env.SHOP_COLLECT_INTERVAL_MINUTES;
    expect(collectIntervalMs()).toBe(0);
    process.env.SHOP_COLLECT_INTERVAL_MINUTES = "0";
    expect(collectIntervalMs()).toBe(0);
    process.env.SHOP_COLLECT_INTERVAL_MINUTES = "abc";
    expect(collectIntervalMs()).toBe(0);
  });

  it("低于下限的间隔被抬到 5 分钟，避免把站点打到限流", () => {
    process.env.SHOP_COLLECT_INTERVAL_MINUTES = "1";
    expect(collectIntervalMs()).toBe(5 * 60_000);
  });

  it("正常值按分钟换算", () => {
    process.env.SHOP_COLLECT_INTERVAL_MINUTES = "30";
    expect(collectIntervalMs()).toBe(30 * 60_000);
  });
});

describe("startScheduledCollection", () => {
  it("未配置间隔时不注册定时器", () => {
    delete process.env.SHOP_COLLECT_INTERVAL_MINUTES;
    const d = db();
    const handle = startScheduledCollection(d, {}, () => {});
    expect(handle.enabled).toBe(false);
    handle.stop();
    d.close();
  });

  it("SHOP_COLLECT_ON_START=1 时立即入队一个全量任务", async () => {
    process.env.SHOP_COLLECT_INTERVAL_MINUTES = "60";
    process.env.SHOP_COLLECT_ON_START = "1";
    const d = db();
    const deps = { resolveCollector: () => async () => [] };

    const handle = startScheduledCollection(d, deps, () => {});
    const jobs = d.prepare("SELECT job_type, requested_by FROM collection_jobs").all() as any[];

    expect(handle.enabled).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ job_type: "all", requested_by: "cron" });

    handle.stop();
    await drainJobs(d, deps); // 等调度器把入队任务跑完，避免关库时后台仍在写
    d.close();
  });

  it("上一轮仍在进行时不重复入队（DB 级防重）", async () => {
    process.env.SHOP_COLLECT_INTERVAL_MINUTES = "60";
    process.env.SHOP_COLLECT_ON_START = "1";
    const d = db();
    const deps = { resolveCollector: () => async () => [] };
    const existing = enqueueJob(d, { jobType: "all", requestedBy: "ui" });

    const handle = startScheduledCollection(d, deps, () => {});
    const jobs = d.prepare("SELECT id FROM collection_jobs").all() as any[];

    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(existing.jobId);

    handle.stop();
    await drainJobs(d, deps);
    d.close();
  });
});
