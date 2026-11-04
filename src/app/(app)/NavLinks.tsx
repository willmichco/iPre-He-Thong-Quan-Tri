"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "./nav";

export function NavLinks({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const items = compact ? NAV.filter((n) => ["/", "/quet-ma", "/kho", "/ban-hang", "/chuyen-hang"].includes(n.href)) : NAV;
  return (
    <>
      {items.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return compact ? (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${active ? "text-primary font-semibold" : "text-muted"}`}
          >
            <span aria-hidden className="text-base leading-none">
              {n.icon}
            </span>
            {n.label}
          </Link>
        ) : (
          <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className="nav-link">
            <span aria-hidden className="w-5 text-center">
              {n.icon}
            </span>
            {n.label}
          </Link>
        );
      })}
    </>
  );
}
