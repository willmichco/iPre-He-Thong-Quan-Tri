"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { NavIcon } from "./_components/NavIcon";
import { isActive, NAV, NAV_GROUPS, TAB_BAR } from "./nav";

/** Thanh bên máy tính: các mục xếp theo nhóm (Vận hành · Tài chính · Hệ thống). */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {NAV.map((n, k) => (
        <Fragment key={n.href}>
          {(k === 0 || NAV[k - 1].group !== n.group) && <div className={`nav-group ${k === 0 ? "pt-1" : ""}`}>{NAV_GROUPS[n.group]}</div>}
          <Link href={n.href} aria-current={isActive(n.href, pathname) ? "page" : undefined} className="nav-link">
            <NavIcon name={n.icon} />
            {n.label}
          </Link>
        </Fragment>
      ))}
    </>
  );
}

const TABS = TAB_BAR.map((href) => NAV.find((n) => n.href === href)!);
const MORE = NAV.filter((n) => !(TAB_BAR as readonly string[]).includes(n.href));

/**
 * Thanh tab nổi ở đáy màn hình điện thoại: 4 mục hằng ngày, nút Quét nổi bật ở giữa, và "Thêm" mở bảng
 * các mục còn lại (Chuyến hàng, Vận chuyển, Thu chi, Báo cáo, Danh mục, Cài đặt) + đăng xuất.
 * Bảng luôn có trong DOM (ẩn bằng `inert`) để mở / đóng chỉ là đổi thuộc tính — trượt mượt, không dựng lại.
 */
export function MobileNav({ account }: { account: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  // đổi trang → đóng bảng (cập nhật trong lúc render, không cần effect)
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const moreActive = MORE.some((n) => isActive(n.href, pathname));
  const [left, right] = [TABS.slice(0, 2), TABS.slice(3)];
  const scan = TABS[2];

  return (
    <div className="md:hidden">
      <div className="sheet-backdrop" data-open={open || undefined} onClick={() => setOpen(false)} aria-hidden />
      <div id="more-sheet" className="sheet glass-strong" data-open={open || undefined} inert={!open} role="dialog" aria-modal="true" aria-label="Mục khác">
        <ul className="grid grid-cols-3 gap-2">
          {MORE.map((n) => (
            <li key={n.href}>
              <Link href={n.href} className="sheet-tile" aria-current={isActive(n.href, pathname) ? "page" : undefined}>
                <NavIcon name={n.icon} className="h-6 w-6" />
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
        {account}
      </div>

      <nav
        aria-label="Điều hướng nhanh"
        className="glass-strong fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+10px)] z-40 flex items-center gap-1 rounded-[30px] p-1.5"
      >
        {left.map((n) => (
          <Link key={n.href} href={n.href} aria-current={isActive(n.href, pathname) ? "page" : undefined} className="tab-link">
            <NavIcon name={n.icon} className="h-[22px] w-[22px]" />
            {n.label}
          </Link>
        ))}
        <Link href={scan.href} aria-current={isActive(scan.href, pathname) ? "page" : undefined} className="tab-link tab-scan">
          <span>
            <NavIcon name="scan" className="h-[22px] w-[22px]" />
          </span>
          {scan.label}
        </Link>
        {right.map((n) => (
          <Link key={n.href} href={n.href} aria-current={isActive(n.href, pathname) ? "page" : undefined} className="tab-link">
            <NavIcon name={n.icon} className="h-[22px] w-[22px]" />
            {n.label}
          </Link>
        ))}
        <button
          type="button"
          className="tab-link"
          aria-expanded={open}
          aria-controls="more-sheet"
          aria-current={moreActive && !open ? "page" : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <NavIcon name="more" className="h-[22px] w-[22px]" />
          Thêm
        </button>
      </nav>
    </div>
  );
}
