import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "iPre — Hệ thống quản trị",
  description: "Quản lý nhập hàng Apple từ Mỹ: chuyến hàng, vận chuyển, tồn kho, bán hàng, thu chi, lãi lỗ.",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "iPre", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
