"use client";

import { useEffect } from "react";

/** Đăng ký service worker (chỉ bản chạy thật — khi phát triển, service worker dễ giữ mã cũ gây khó hiểu). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      /* không có service worker vẫn dùng bình thường */
    });
  }, []);
  return null;
}
