import "./load-env";
import { openDatabase } from "./db/connection";
import { applySchema, defaultDbPath } from "./db/init";
import { migrateSourceKinds } from "./core/sourceProbe";

const dbPath = defaultDbPath();
const db = openDatabase(dbPath);

try {
  applySchema(db);
  const result = await migrateSourceKinds(db);
  console.log(`存量采集器识别完成：${result.updated}/${result.total} 个来源已更新`);
  for (const item of result.items) {
    const status = item.updated ? "updated" : "skipped";
    console.log(`${status}\t${item.name}\t${item.oldKind || "auto"} -> ${item.kind}\t${item.evidence}`);
  }
} finally {
  db.close();
}
