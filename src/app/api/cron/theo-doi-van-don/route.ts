import { timingSafeEqual } from "node:crypto";
import { getSql } from "@/server/db/client";
import { runTrackingBot } from "@/server/tracking/service";

/**
 * Lịch chạy bot theo dõi vận đơn (2 lần / ngày). Gọi bằng cron của máy chủ hoặc dịch vụ cron:
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<máy chủ>/api/cron/theo-doi-van-don
 * Không cần phiên đăng nhập — xác thực bằng CRON_SECRET (≥ 32 ký tự). Thiếu CRON_SECRET → tắt.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function handle(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!process.env.CRON_SECRET) return Response.json({ error: "CRON_SECRET chưa cấu hình" }, { status: 503, headers });
  if (!authorized(req)) return Response.json({ error: "Không có quyền" }, { status: 401, headers });
  const db = getSql();
  if (!db) return Response.json({ error: "Chưa kết nối cơ sở dữ liệu" }, { status: 503, headers });
  const r = await runTrackingBot(db, { trigger: "SCHEDULE" });
  return Response.json(r, { headers });
}

export const GET = handle; // dịch vụ cron chỉ gọi GET (kèm Authorization: Bearer)
export const POST = handle;
