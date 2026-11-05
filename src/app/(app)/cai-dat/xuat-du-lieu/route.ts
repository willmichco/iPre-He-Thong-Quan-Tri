import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";
import { exportAllData } from "@/server/settings/service";

/** Tải toàn bộ dữ liệu (ZIP các tệp CSV). Chỉ chủ hàng đã đăng nhập; ghi nhật ký mỗi lần xuất (gói có dữ liệu cá nhân). */
export async function GET() {
  await requireOwner();
  const db = getSql();
  if (!db) return new Response("Chưa kết nối cơ sở dữ liệu", { status: 503 });
  const out = await exportAllData(db);
  await db`INSERT INTO audit_logs (action, entity_type, after) VALUES ('CREATE', 'data_export', ${db.json({ filename: out.filename, counts: out.counts })})`;
  return new Response(new Uint8Array(out.zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${out.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
