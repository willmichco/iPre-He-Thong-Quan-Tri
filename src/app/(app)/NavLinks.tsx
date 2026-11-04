"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcon } from "./_components/NavIcon";
import { NAV } from "./nav";

export function NavLinks({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const items = compact ? NAV.filter((n) => ["/", "/quet-ma", "/kho", "/ban-hang", "/chuyen-hang"].includes(n.href)) : NAV;
  return (
    <>
      {items.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return compact ? (
          <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className="tab-link">
            <NavIcon name={n.icon} className="h-[22px] w-[22px]" />
            {n.label}
          </Link>
        ) : (
          <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className="nav-link">
            <NavIcon name={n.icon} />
            {n.label}
          </Link>
        );
      })}
    </>
  );
}
