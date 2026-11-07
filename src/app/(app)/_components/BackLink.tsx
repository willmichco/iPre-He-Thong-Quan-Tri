import Link from "next/link";
import type { ReactNode } from "react";
import { Glyph } from "./Glyph";

/** Liên kết quay lại trang cha — một kiểu cho mọi trang chi tiết. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="back-link">
      <Glyph name="back" size={16} />
      {children}
    </Link>
  );
}
