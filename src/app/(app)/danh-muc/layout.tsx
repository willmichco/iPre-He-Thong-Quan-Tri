import { Tabs } from "./ui";

const TABS = [
  { href: "/danh-muc", label: "Mẫu máy & cấu hình" },
  { href: "/danh-muc/ma-may", label: "Mã Part No. / UPC" },
  { href: "/danh-muc/noi-mua", label: "Nơi mua" },
  { href: "/danh-muc/van-chuyen", label: "Vận chuyển" },
  { href: "/danh-muc/tai-khoan", label: "Tài khoản tiền" },
] as const;

export default function CatalogLayout({ children }: LayoutProps<"/danh-muc">) {
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 className="text-2xl font-bold">Danh mục</h1>
      <p className="mt-1 text-sm text-muted">Dữ liệu gốc dùng chung cho đơn mua, máy, kiện và chi phí. Mọi thay đổi đều được ghi nhật ký.</p>
      <Tabs tabs={TABS} />
      <div className="mt-5">{children}</div>
    </main>
  );
}
