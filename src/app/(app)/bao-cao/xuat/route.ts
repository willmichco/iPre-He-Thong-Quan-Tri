import type { NextRequest } from "next/server";
import { isReportKey, parseRange } from "@/domain/reports";
import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";
import { exportReport } from "@/server/reports/export";
import { buildXlsx, XLSX_MIME } from "@/server/reports/xlsx";
import { todayVn } from "../../van-chuyen/shared";

/** Xuất một báo cáo ra Excel: /bao-cao/xuat?bc=lai-lo&ky=thang (hoặc &tu=…&den=…). Chỉ chủ hàng đã đăng nhập. */
export async function GET(req: NextRequest) {
  await requireOwner();
  const db = getSql();
  if (!db) return new Response("Chưa kết nối cơ sở dữ liệu", { status: 503 });
  const p = req.nextUrl.searchParams;
  const key = p.get("bc") ?? "";
  if (!isReportKey(key)) return new Response("Báo cáo không tồn tại", { status: 404 });
  const today = todayVn();
  const { filename, sheets } = await exportReport(db, key, parseRange({ ky: p.get("ky"), tu: p.get("tu"), den: p.get("den") }, today), today);
  return new Response(new Uint8Array(buildXlsx(sheets)), {
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
