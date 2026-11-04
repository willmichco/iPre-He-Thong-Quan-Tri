import Link from "next/link";
import { notFound } from "next/navigation";
import { NAV } from "../nav";

export function generateStaticParams() {
  // trang đã có thư mục riêng (đã làm xong) không dùng trang "đang xây dựng"
  return NAV.filter((n) => !n.ready && n.href !== "/").map((n) => ({ section: n.href.slice(1) }));
}
export const dynamicParams = false;

export default async function SectionPlaceholder({ params }: PageProps<"/[section]">) {
  const { section } = await params;
  const item = NAV.find((n) => n.href === `/${section}`);
  if (!item) notFound();
  return (
    <main className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="text-2xl font-bold">{item.label}</h1>
      <p className="mt-1 text-muted">{item.description}</p>
      <div className="card mt-6 p-5">
        <p>
          Màn hình này được xây dựng ở <b>{item.phase}</b> theo lộ trình trong <code>docs/06-lo-trinh-rui-ro-phap-ly.md</code>.
        </p>
        <p className="mt-2 text-sm text-muted">
          Hiện có thể dùng thử: <Link href="/quet-ma" className="underline">Quét mã</Link>.
        </p>
      </div>
    </main>
  );
}
