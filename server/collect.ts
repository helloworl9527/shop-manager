import "./load-env";
import { openDatabase } from "./db/connection";
import { defaultDbPath } from "./db/init";
import { clearStaleLocks } from "./db/repo";
import { enqueueJob, runJob } from "./core/jobs";

/**
 * 采集 CLI（M2：直连 SQLite 跑通；M3 改为瘦客户端打后端）。
 *   node server/collect.ts --all
 *   node server/collect.ts --source <sourceId>
 *   可选：--db <path> --concurrency <n>
 */
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = typeof args.db === "string" ? args.db : defaultDbPath();
  const concurrency = typeof args.concurrency === "string" ? Number(args.concurrency) : 15;

  if (!args.all && !args.source) {
    console.error("用法: --all | --source <sourceId> [--db <path>] [--concurrency <n>]");
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  const swept = clearStaleLocks(db); // 启动清扫过期锁
  if (swept) console.log(`已清理 ${swept} 个过期源锁`);

  try {
    if (args.all) {
      const { jobId } = enqueueJob(db, { jobType: "all", requestedBy: "cli" });
      const r = await runJob(db, jobId, { concurrency });
      const all = r.all!;
      console.log(`\n全量采集 ${all.status}：共 ${all.total} 源`);
      if (all.skippedSources.length) console.log(`跳过(被锁) ${all.skippedSources.length}：${all.skippedSources.join(", ")}`);
      console.table(
        all.results.map((x) => ({ 店铺: x.sourceName.slice(0, 20), 状态: x.status, 采到: x.offerCount, 写入: x.written, 下架: x.delisted })),
      );
    } else {
      const sourceId = String(args.source);
      const { jobId } = enqueueJob(db, { jobType: "source", sourceId, requestedBy: "cli" });
      const r = await runJob(db, jobId, { concurrency });
      console.log(`\n单源采集结果：`, JSON.stringify(r.source ?? r, null, 2));
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("采集失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
