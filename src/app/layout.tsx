import type { Metadata, Viewport } from "next";
// Phông Be Vietnam Pro tự chứa (không phụ thuộc mạng lúc build); mỗi độ đậm gồm bộ ký tự Latin + tiếng Việt,
// trình duyệt chỉ tải tệp của bộ ký tự có trên trang (unicode-range).
import "@fontsource/be-vietnam-pro/400.css";
import "@fontsource/be-vietnam-pro/500.css";
import "@fontsource/be-vietnam-pro/600.css";
import "@fontsource/be-vietnam-pro/700.css";
import "./globals.css";
import { PwaRegister } from "./PwaRegister";

export const metadata: Metadata = {
  title: "iPre — Hệ thống quản trị",
  description: "Quản lý nhập hàng Apple từ Mỹ: chuyến hàng, vận chuyển, tồn kho, bán hàng, thu chi, lãi lỗ.",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "iPre", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef1f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0c11" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className="h-full antialiased">
      <body className="min-h-full">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
