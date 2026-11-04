import { getSql } from "@/server/db/client";

/** Kiểm tra sức khoẻ: ứng dụng chạy và (nếu cấu hình) CSDL trả lời. Không lộ thông tin nhạy cảm. */
export async function GET() {
  const sql = getSql();
  let database: "ok" | "not_configured" | "error" = "not_configured";
  let migrations: number | null = null;
  if (sql) {
    try {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM schema_migrations`;
      database = "ok";
      migrations = row.n;
    } catch {
      database = "error";
    }
  }
  return Response.json(
    { status: database === "error" ? "degraded" : "ok", database, migrations },
    { status: database === "error" ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
