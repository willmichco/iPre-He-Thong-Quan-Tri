"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Thanh mục cuộn ngang (.segmented) trên điện thoại: sau mỗi lần chuyển trang / đổi bộ lọc, cuộn mục đang chọn vào giữa
 * khung — không thì mục đang mở (vd "Nơi mua", "Thuế") nằm khuất bên phải. Chỉ đổi scrollLeft của thanh, không cuộn trang.
 */
export function SegmentScroll() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    for (const bar of document.querySelectorAll<HTMLElement>(".segmented")) {
      if (bar.scrollWidth <= bar.clientWidth) continue;
      const on = bar.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"]');
      if (!on) continue;
      const r = on.getBoundingClientRect();
      const left = bar.scrollLeft + r.left - bar.getBoundingClientRect().left - (bar.clientWidth - r.width) / 2;
      bar.scrollTo({ left: Math.max(0, left), behavior: "instant" });
    }
  }, [pathname, search]);
  return null;
}
