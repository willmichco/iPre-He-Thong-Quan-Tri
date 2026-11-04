import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { SALE_STATUS_LABEL } from "@/domain/sales";
import { listSales } from "@/server/sales/service";
import { catalogDb, Empty, NoDatabase } from "../danh-muc/shared";

export const metadata = { title: "Bán hàng" };

const dmy = (ts: string) => new Date(ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

export default async function SalesPage() {
  const db = await catalogDb();
  const sales = db ? await listSales(db) : [];
  const owed = sales.filter((s) => s.balanceVnd > 0n);
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Bán hàng</h1>
        <Link href="/ban-hang/moi" className="btn-primary ml-auto">
          + Bán máy
        </Link>
      </div>
      {!db ? (
        <div className="mt-4">
          <NoDatabase />
        </div>
      ) : (
        <>
          {owed.length > 0 && (
            <p className="mt-3 text-sm text-[var(--warn)]">
              ⚠ {owed.length} đơn còn phải thu: {formatVnd(owed.reduce((a, s) => a + s.balanceVnd, 0n))} ₫
            </p>
          )}
          <section className="mt-4" aria-label="Đơn bán gần đây">
            {sales.length === 0 ? (
              <Empty>Chưa có đơn bán.</Empty>
            ) : (
              <ul className="flex flex-col gap-2">
                {sales.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/ban-hang/${s.id}`}
                      className="card flex flex-wrap items-center gap-x-4 gap-y-1 p-4 transition-transform hover:-translate-y-0.5"
                      aria-label={`Đơn ${s.code}`}
                    >
                      <b>{s.code}</b>
                      <span className="text-sm text-muted">{dmy(s.soldAt)}</span>
                      <span className="text-sm">{s.customer ?? "Khách lẻ"}</span>
                      <span className="text-xs rounded-full border border-border px-2 py-0.5">{SALE_STATUS_LABEL[s.status] ?? s.status}</span>
                      <span className="ml-auto text-sm tabular-nums">
                        {s.itemCount} máy · {formatVnd(s.revenueVnd)} ₫
                        {s.profitVnd !== null && (
                          <span className={s.profitVnd < 0n ? " text-danger" : " text-[var(--ok)]"}> · lãi {formatVnd(s.profitVnd)} ₫</span>
                        )}
                        {s.balanceVnd > 0n && <span className="text-[var(--warn)]"> · còn thu {formatVnd(s.balanceVnd)} ₫</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
