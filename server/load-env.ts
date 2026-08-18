import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 极简 .env 加载（无依赖）。在 index.ts 里**第一个**导入，确保后续模块读 process.env 时已就绪。
 * 放项目根的 .env，例如：
 *   PORT=3000
 *   SHOP_DB_PATH=/path/to/shop.db
 * 已存在的环境变量不会被覆盖（命令行传入优先）。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
