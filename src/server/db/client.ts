import "server-only";
import postgres from "postgres";

/** Kết nối PostgreSQL dùng chung (một pool cho mỗi tiến trình). */
const globalForDb = globalThis as unknown as { __ipreSql?: ReturnType<typeof postgres> };

export function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  globalForDb.__ipreSql ??= postgres(url, { max: 5, idle_timeout: 30, onnotice: () => {} });
  return globalForDb.__ipreSql;
}
