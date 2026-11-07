import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { SALE_STATUS_LABEL } from "@/domain/sales";
import { listSales } from "@/server/sales/service";
import { catalogDb, Empty, NoDatabase } from "../danh-muc/shared";
import { Glyph } from "../_components/Glyph";
import { SALE_TONE } from "../_components/tones";

export const metadata = { title: "Bán hàng" };

const dmy = (ts: string) => new Date(ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

export default async function SalesPage() {
  const db = await catalogDb();
  const sales = db ? await listSales(db) : [];
  const owed = sales.filter((s) => s.balanceVnd > 0n);
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Bán hàng</h1>
        <div className="flex gap-2">
          <Link href="/ban-hang/khach-hang" className="btn-secondary px-4">
            Khách hàng
          </Link>
          <Link href="/ban-hang/moi" className="btn-primary px-4">
            + Bán máy
          </Link>
        </div>
      </div>
      {!db ? (
        <div className="mt-4">
          <NoDatabase />
        </div>
      ) : (
        <>
          {owed.length > 0 && (
            <div className="callout mt-3" data-tone="warn">
              <Glyph name="warn" size={17} />
              <p>
                <b>{owed.length} đơn còn phải thu:</b> {formatVnd(owed.reduce((a, s) => a + s.balanceVnd, 0n))} ₫
              </p>
            </div>
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
                      <span className="badge" data-tone={SALE_TONE[s.status] ?? "muted"}>
                        {SALE_STATUS_LABEL[s.status] ?? s.status}
                      </span>
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
