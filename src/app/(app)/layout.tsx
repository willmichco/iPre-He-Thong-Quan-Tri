import { requireOwner } from "@/server/auth/session";
import { logout } from "../dang-nhap/actions";
import { BrandMark } from "./_components/BrandMark";
import { NavIcon } from "./_components/NavIcon";
import { MobileNav, NavLinks } from "./NavLinks";

function Account({ email, compact = false }: { email: string; compact?: boolean }) {
  return (
    <form action={logout} className={`flex flex-col gap-1 rounded-2xl bg-[var(--fill)] p-2 ${compact ? "mt-3" : ""}`}>
      <div className="flex items-center gap-2.5 px-1 pt-1">
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--primary)] to-[var(--primary-2)] text-[13px] font-semibold uppercase text-white"
        >
          {email.slice(0, 1)}
        </span>
        <span className="min-w-0">
          <span className="block text-[11px] leading-tight text-muted">Tài khoản chủ</span>
          <span className="block truncate text-[13px] font-medium leading-snug">{email}</span>
        </span>
      </div>
      <button
        type="submit"
        className="inline-flex min-h-9 items-center gap-2 rounded-xl px-2 text-[13px] font-medium text-muted transition-colors hover:bg-[var(--fill)] hover:text-danger"
      >
        <NavIcon name="logout" className="h-4 w-4" />
        Đăng xuất
      </button>
    </form>
  );
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const owner = await requireOwner();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[268px_1fr]">
      <aside className="sticky top-0 hidden h-dvh p-3 md:block">
        <div className="glass-panel flex h-full flex-col rounded-[28px] p-3">
          <div className="mb-2 flex items-center gap-3 px-2 pt-1">
            <BrandMark className="h-10 w-10" />
            <div>
              <div className="text-[17px] font-semibold leading-tight tracking-tight">iPre</div>
              <div className="text-xs text-muted">Hệ thống quản trị</div>
            </div>
          </div>
          <nav className="-mr-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto pr-1 pt-2" aria-label="Điều hướng chính">
            <NavLinks />
          </nav>
          <div className="mt-auto pt-3">
            <Account email={owner.email} />
          </div>
        </div>
      </aside>

      <div className="min-w-0 pb-[calc(env(safe-area-inset-bottom)+96px)] md:pb-0">
        {owner.devBypass && (
          <div
            className="mx-3 mt-3 flex items-start gap-2 rounded-2xl bg-[var(--warn-bg)] px-3.5 py-2 text-xs leading-relaxed text-[var(--warn)] md:mx-8 md:text-sm"
          >
            <span aria-hidden className="mt-px font-bold">
              ⚠
            </span>
            <span>
              <b>Chế độ phát triển</b>: chưa cấu hình đăng nhập nên đang cho vào thẳng. Môi trường thật luôn yêu cầu đăng nhập 2 lớp.
            </span>
          </div>
        )}
        {children}
      </div>

      <MobileNav account={<Account email={owner.email} compact />} />
    </div>
  );
}
