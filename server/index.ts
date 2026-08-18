import "./load-env"; // 必须第一个导入：加载 .env，供后续模块读 process.env
import { openDatabase } from "./db/connection";
import { defaultDbPath, initDatabase } from "./db/init";
import { recoverOnStartup } from "./core/scheduler";
import { startScheduledCollection } from "./core/cron";
import { buildServer } from "./api/server";
import { listSourceMethodDrift } from "./db/data";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

async function main() {
  const dbPath = process.env.SHOP_DB_PATH || defaultDbPath();
  // 确保表与分类目录存在（幂等）
  initDatabase(dbPath);

  const db = openDatabase(dbPath);
  const recovered = recoverOnStartup(db);
  if (recovered.clearedLocks || recovered.failedJobs) {
    console.log(`启动恢复：清理 ${recovered.clearedLocks} 个过期锁，${recovered.failedJobs} 个僵尸任务标记失败`);
  }
  const methodDrift = listSourceMethodDrift(db);
  if (methodDrift.length) {
    console.warn(`采集器巡检：发现 ${methodDrift.length} 个非 browser 店铺仍使用 browser method，请在后台重新识别。`);
  }

  const deps = { concurrency: 15 };
  const app = buildServer(db, { deps });
  await app.listen({ port: PORT, host: HOST });
  console.log(`后端已启动：http://${HOST}:${PORT}  (DB: ${dbPath})`);

  const scheduled = startScheduledCollection(db, deps);
  console.log(
    scheduled.enabled
      ? `定时采集：每 ${scheduled.intervalMs / 60_000} 分钟一次全量采集`
      : "定时采集：未启用（设 SHOP_COLLECT_INTERVAL_MINUTES 开启）",
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      scheduled.stop();
      await app.close();
      db.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("启动失败：", err);
  process.exit(1);
});
