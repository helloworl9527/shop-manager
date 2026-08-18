import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

export interface OpenOptions {
  readonly?: boolean;
}

/**
 * 打开一个 SQLite 连接并应用统一 PRAGMA。
 *
 * 重要：foreign_keys / busy_timeout / synchronous 都是「按连接」生效的，
 * 不会持久化到数据库文件，所以**每一个连接**都必须在这里集中启用，
 * 这是全项目唯一的建连入口，避免某处忘记开外键导致约束形同虚设。
 */
export function openDatabase(path: string, options: OpenOptions = {}): SqliteDatabase {
  const db = new Database(path, { readonly: options.readonly ?? false });
  db.pragma("journal_mode = WAL");    // 并发读 + 单写
  db.pragma("busy_timeout = 5000");   // 写冲突自动等待重试
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");     // 必须：每个连接都要开，否则外键不生效
  return db;
}

export type { SqliteDatabase };
