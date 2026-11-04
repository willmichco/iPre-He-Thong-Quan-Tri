import { requireOwner } from "@/server/auth/session";
import { logout } from "../dang-nhap/actions";
import { NavLinks } from "./NavLinks";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const owner = await requireOwner();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
      <aside className="hidden md:flex md:flex-col gap-1 border-r border-border bg-surface p-3 sticky top-0 h-dvh">
        <div className="px-3 py-2 mb-2">
          <div className="text-lg font-bold">iPre</div>
          <div className="text-xs text-muted">Hệ thống quản trị</div>
        </div>
        <nav className="flex flex-col gap-1" aria-label="Điều hướng chính">
          <NavLinks />
        </nav>
        <form action={logout} className="mt-auto px-3 py-2">
          <div className="text-xs text-muted truncate mb-1">{owner.email}</div>
          <button type="submit" className="text-sm text-muted hover:text-text underline">
            Đăng xuất
          </button>
        </form>
      </aside>

      <div className="min-w-0 pb-20 md:pb-0">
        {owner.devBypass && (
          <div className="bg-[var(--warn-bg)] text-[var(--warn)] text-sm px-4 py-2">
            Chế độ phát triển: chưa cấu hình đăng nhập nên đang cho vào thẳng. Môi trường thật luôn yêu cầu đăng nhập 2 lớp.
          </div>
        )}
        {children}
      </div>

      <nav
        aria-label="Điều hướng nhanh"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 flex border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        <NavLinks compact />
      </nav>
    </div>
  );
}
