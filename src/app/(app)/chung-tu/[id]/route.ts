import type { NextRequest } from "next/server";
import { requireOwner } from "@/server/auth/session";
import { getAttachment } from "@/server/attachments/service";
import { fileStore } from "@/server/attachments/storage";
import { getSql } from "@/server/db/client";

/**
 * Xem / tải một chứng từ: /chung-tu/<id> (mở trong trình duyệt), thêm ?tai=1 để tải về.
 * Chỉ chủ hàng đã đăng nhập. Loại tệp đã được xác định theo nội dung lúc tải lên (chỉ ảnh / PDF).
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/chung-tu/[id]">) {
  await requireOwner();
  const db = getSql();
  if (!db) return new Response("Chưa kết nối cơ sở dữ liệu", { status: 503 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Không tìm thấy", { status: 404 });
  const a = await getAttachment(db, id);
  if (!a) return new Response("Không tìm thấy chứng từ", { status: 404 });
  let body: Buffer;
  try {
    body = await fileStore().get(a.fileKey);
  } catch {
    return new Response("Tệp chứng từ không còn trong kho lưu trữ", { status: 410 });
  }
  const download = req.nextUrl.searchParams.get("tai") === "1";
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": a.mimeType,
      "Content-Length": String(body.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${a.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
