/*
 * Service worker của iPre (PWA).
 * NGUYÊN TẮC: không bao giờ lưu đệm dữ liệu kinh doanh (trang HTML, Server Action, API, chứng từ) — số liệu tài chính
 * phải luôn là số mới nhất từ máy chủ. Chỉ lưu đệm tài nguyên tĩnh có mã băm trong tên (/_next/static, /wasm, /ocr,
 * biểu tượng) để mở nhanh, và một trang "mất kết nối" hiện khi điện thoại không có mạng.
 */
const VERSION = "ipre-v1";
const STATIC = `${VERSION}-static`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Tài nguyên tĩnh bất biến (tên có mã băm / thư viện quét mã) → lưu đệm, dùng lại. */
const isImmutable = (url) =>
  url.origin === self.location.origin &&
  (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/wasm/") || url.pathname.startsWith("/ocr/") || url.pathname.startsWith("/icons/"));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // Server Action, đăng nhập… luôn đi thẳng máy chủ
  const url = new URL(req.url);

  if (isImmutable(url)) {
    event.respondWith(
      caches.open(STATIC).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Mở trang: luôn lấy từ máy chủ; chỉ khi mất mạng mới hiện trang "mất kết nối" (không bao giờ trang cũ có số liệu)
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
  }
});
