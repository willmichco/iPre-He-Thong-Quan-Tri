import { Tabs } from "../_components/form";

const TABS = [
  { href: "/thu-chi", label: "Sổ quỹ" },
  { href: "/thu-chi/cong-no", label: "Công nợ" },
  { href: "/thu-chi/danh-muc", label: "Danh mục thu chi" },
] as const;

export default function CashLayout({ children }: LayoutProps<"/thu-chi">) {
  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <h1 className="text-2xl font-bold">Thu chi</h1>
      <p className="mt-1 text-sm text-muted">
        Sổ quỹ nhiều tài khoản. Tiền trả đơn mua là <b>dòng tiền ra</b>, chưa phải chi phí — nó thành giá vốn khi máy được bán.
      </p>
      <Tabs tabs={TABS} label="Mục thu chi" />
      <div className="mt-5">{children}</div>
    </main>
  );
}
