import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";

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

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="card p-5 text-sm text-muted">{children}</p>;
}
