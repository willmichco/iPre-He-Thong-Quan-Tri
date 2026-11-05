import type { MetadataRoute } from "next";

/** Ứng dụng cài lên màn hình chính điện thoại (PWA). Không cần đăng nhập để tải tệp này. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "iPre — Hệ thống quản trị",
    short_name: "iPre",
    description: "Quản lý nhập hàng Apple từ Mỹ: chuyến hàng, vận chuyển, tồn kho, bán hàng, thu chi, lãi lỗ.",
    lang: "vi",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#eef1f7",
    theme_color: "#eef1f7",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Bán máy", short_name: "Bán", url: "/ban-hang/moi", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Quét mã", short_name: "Quét", url: "/quet-ma", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Kho máy", short_name: "Kho", url: "/kho", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
