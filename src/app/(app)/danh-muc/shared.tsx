import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";
import { Glyph } from "../_components/Glyph";

/** Trang danh mục: kiểm tra phiên rồi lấy kết nối CSDL (null = chưa cấu hình DATABASE_URL). */
export async function catalogDb() {
  await requireOwner();
  return getSql();
}

export function NoDatabase() {
  return (
    <div className="card p-5" role="alert">
      <p className="font-semibold">Chưa kết nối cơ sở dữ liệu</p>
      <p className="mt-1 text-sm text-muted">
        Đặt <code>DATABASE_URL</code> trong <code>.env.local</code> rồi chạy <code>npm run db:migrate</code> (xem README).
      </p>
    </div>
  );
}

/** Trạng thái trống — một kiểu cho mọi danh sách. */
export function Empty({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`card empty-state ${className}`}>
      <span className="icon-tile h-9 w-9 rounded-[11px]" data-tone="muted">
        <Glyph name="inbox" size={18} />
      </span>
      <p>{children}</p>
    </div>
  );
}
