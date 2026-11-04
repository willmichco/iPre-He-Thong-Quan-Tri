import { requireOwner } from "@/server/auth/session";
import { logout } from "../dang-nhap/actions";
import { NavLinks } from "./NavLinks";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const owner = await requireOwner();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[264px_1fr]">
      <aside className="hidden md:block sticky top-0 h-dvh p-3">
        <div className="glass-strong flex h-full flex-col gap-1 rounded-[26px] p-3">
          <div className="mb-3 flex items-center gap-3 px-2 pt-1">
            <span
              aria-hidden
              className="grid h-9 w-9 place-items-center rounded-[11px] bg-gradient-to-br from-[#4f9dff] to-[#7a5cff] text-[15px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
            >
              i
            </span>
            <div>
              <div className="text-[17px] font-semibold leading-tight">iPre</div>
              <div className="text-xs text-muted">Hệ thống quản trị</div>
            </div>
          </div>
          <nav className="flex flex-col gap-0.5" aria-label="Điều hướng chính">
            <NavLinks />
          </nav>
          <form action={logout} className="mt-auto rounded-2xl bg-[var(--fill)] px-3 py-2.5">
            <div className="mb-1 truncate text-xs text-muted">{owner.email}</div>
            <button type="submit" className="text-sm font-medium text-primary hover:underline">
              Đăng xuất
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 pb-28 md:pb-0">
        {owner.devBypass && (
          <div className="mx-3 mt-3 rounded-2xl bg-[var(--warn-bg)] px-4 py-2 text-sm text-[var(--warn)] md:mx-8">
            Chế độ phát triển: chưa cấu hình đăng nhập nên đang cho vào thẳng. Môi trường thật luôn yêu cầu đăng nhập 2 lớp.
          </div>
        )}
        {children}
      </div>

      <nav
        aria-label="Điều hướng nhanh"
        className="glass-strong md:hidden fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+10px)] z-40 flex gap-1 rounded-full p-1.5"
      >
        <NavLinks compact />
      </nav>
    </div>
  );
}
