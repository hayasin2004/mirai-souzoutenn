import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { DATA_DIR, DB_PATH } from "@/lib/paths";
import * as schema from "./schema";

type Db = BetterSQLite3Database<typeof schema>;

// 開発時のホットリロードで接続が増えないよう globalThis に置く
const globalForDb = globalThis as unknown as { __db?: Db };

function open(): Db {
  mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

export function getDb(): Db {
  globalForDb.__db ??= open();
  return globalForDb.__db;
}
