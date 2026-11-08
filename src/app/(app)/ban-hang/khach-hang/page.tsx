import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { listCustomers } from "@/server/customers/service";
import { ActionForm, Submit } from "../../_components/form";
import { catalogDb, Empty, NoDatabase } from "../../danh-muc/shared";
import { saveCustomerAction } from "./actions";
import { CustomerFields } from "./fields";
import { BackLink } from "../../_components/BackLink";

export const metadata = { title: "Khách hàng — Bán hàng" };

const dmy = (d: string) => d.split("-").reverse().join("/");

export default async function CustomersPage({ searchParams }: PageProps<"/ban-hang/khach-hang">) {
  const db = await catalogDb();
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? "";
  const rows = db ? await listCustomers(db, q) : [];
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <BackLink href="/ban-hang">Bán hàng</BackLink>
      <h1 className="mt-1 text-2xl font-bold">Khách hàng</h1>
      <p className="mt-1 text-sm text-muted">
        Chỉ lưu thông tin cần cho giao hàng và bảo hành (Luật Bảo vệ dữ liệu cá nhân). Khách mới cũng tự được tạo khi bán hàng có số điện thoại.
      </p>
      {!db ? (
        <div className="mt-4">
          <NoDatabase />
        </div>
      ) : (
        <>
          <form method="get" role="search" className="mt-4 flex gap-2">
            <label className="flex grow flex-col gap-1 text-sm">
              <span className="text-muted">Tìm theo tên / số điện thoại / Zalo</span>
              <input name="q" defaultValue={q} className="field" autoComplete="off" />
            </label>
            <button type="submit" className="btn-secondary self-end">
              Tìm
            </button>
          </form>
          <details className="card mt-4 p-4">
            <summary className="cursor-pointer font-semibold">+ Thêm khách</summary>
            <ActionForm action={saveCustomerAction} resetOnSuccess label="Thêm khách" className="field-row mt-3">
              <CustomerFields />
              <Submit>Thêm</Submit>
            </ActionForm>
          </details>
          <div className="mt-4">
            {rows.length === 0 ? (
              <Empty>{q ? `Không có khách nào khớp "${q}".` : "Chưa có khách hàng."}</Empty>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Danh sách khách">
                {rows.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/ban-hang/khach-hang/${c.id}`}
                      className="card flex flex-wrap items-baseline gap-x-4 gap-y-1 p-4 transition-transform hover:-translate-y-0.5"
                      aria-label={`Khách ${c.fullName}`}
                    >
                      <b>{c.fullName}</b>
                      {c.phone && <span className="text-sm text-muted tabular-nums">{c.phone}</span>}
                      <span className="ml-auto text-sm tabular-nums">
                        {c.orders} đơn · {formatVnd(c.revenueVnd)} ₫
                        {c.lastPurchase && <span className="text-muted"> · mua gần nhất {dmy(c.lastPurchase)}</span>}
                        {c.balanceVnd > 0n && <span className="text-[var(--warn)]"> · còn nợ {formatVnd(c.balanceVnd)} ₫</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </main>
  );
}
