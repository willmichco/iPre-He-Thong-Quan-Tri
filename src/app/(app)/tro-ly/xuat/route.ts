import type { NextRequest } from "next/server";
import { parseRange } from "@/domain/reports";
import { exportBangKe } from "@/server/assistant/export";
import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";
import { buildXlsx, XLSX_MIME } from "@/server/reports/xlsx";
import { todayVn } from "../../van-chuyen/shared";

/** Bảng kê Excel (bán · nhập · thu chi · tồn kho · nháp): /tro-ly/xuat?ky=thang (hoặc &tu=…&den=…). Chỉ chủ hàng đã đăng nhập. */
export async function GET(req: NextRequest) {
  await requireOwner();
  const db = getSql();
  if (!db) return new Response("Chưa kết nối cơ sở dữ liệu", { status: 503 });
  const p = req.nextUrl.searchParams;
  const today = todayVn();
  const { filename, sheets } = await exportBangKe(db, parseRange({ ky: p.get("ky"), tu: p.get("tu"), den: p.get("den") }, today), today);
  return new Response(new Uint8Array(buildXlsx(sheets)), {
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
