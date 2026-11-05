import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { daysBetween, debtAgeBucket } from "@/domain/ledger";
import { accountOptions, getDebts, type Payable } from "@/server/ledger/service";
import { ActionForm, Input, Select, Submit } from "../../_components/form";
import { catalogDb, Empty, NoDatabase } from "../../danh-muc/shared";
import { todayVn } from "../../van-chuyen/shared";
import { markPaidAction } from "../actions";

export const metadata = { title: "Công nợ — Thu chi" };

const dmy = (d: string) => d.split("-").reverse().join("/");
const AGE_LABEL = { "0-30": "≤ 30 ngày", "31-60": "31–60 ngày", "61-90": "61–90 ngày", "90+": "> 90 ngày" } as const;
const KIND_LABEL: Record<Payable["kind"], string> = { PURCHASE_ORDER: "Đơn mua", COST: "Cước / chi phí chặng", SALE_EXPENSE: "Chi phí bán hàng" };

export default async function DebtsPage() {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const today = todayVn();
  const [debts, accounts] = await Promise.all([getDebts(db), accountOptions(db)]);
  const accOpts = accounts.map((a) => [a.id, `${a.name}${a.currency === "USD" ? " (USD)" : ""}`] as const);
  const ages = (["0-30", "31-60", "61-90", "90+"] as const).map((b) => ({
    b,
    v: debts.receivables.filter((r) => debtAgeBucket(daysBetween(r.date, today)) === b).reduce((s, r) => s + r.balanceVnd, 0n),
  }));

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="phai-thu">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 id="phai-thu" className="font-semibold">
            Phải thu
          </h2>
          <span className="text-sm tabular-nums" data-testid="receivable-total">
            {formatVnd(debts.receivableVnd)} ₫ · {debts.receivables.length} khoản
          </span>
        </div>
        {debts.receivables.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-2 text-xs text-muted" aria-label="Tuổi nợ">
            {ages.map((a) => (
              <span key={a.b} className={`chip ${a.b === "90+" && a.v > 0n ? "text-danger" : ""}`}>
                {AGE_LABEL[a.b]}: {formatVnd(a.v)} ₫
              </span>
            ))}
          </p>
        )}
        <div className="mt-2">
          {debts.receivables.length === 0 ? (
            <Empty>Không có khoản phải thu.</Empty>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm" aria-label="Danh sách phải thu">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="px-3 py-2 font-normal">Khoản</th>
                    <th className="px-3 py-2 font-normal">Khách / bên nợ</th>
                    <th className="px-3 py-2 font-normal">Ngày</th>
                    <th className="px-3 py-2 text-right font-normal">Tổng</th>
                    <th className="px-3 py-2 text-right font-normal">Đã thu</th>
                    <th className="px-3 py-2 text-right font-normal">Còn phải thu</th>
                  </tr>
                </thead>
                <tbody>
                  {debts.receivables.map((r) => {
                    const days = daysBetween(r.date, today);
                    return (
                      <tr key={`${r.kind}-${r.id}`} className="border-t border-border align-top" data-testid="receivable">
                        <td className="px-3 py-2">
                          <Link href={r.href} className="text-primary">
                            {r.label}
                          </Link>
                          {r.status === "DEPOSITED" && <span className="ml-1 text-xs text-muted">(đang cọc — thu nốt khi giao)</span>}
                        </td>
                        <td className="px-3 py-2">
                          {r.party ?? "—"}
                          {r.phone && <span className="block text-xs text-muted">{r.phone}</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                          {dmy(r.date)} <span className={`text-xs ${days > 60 ? "text-danger" : "text-muted"}`}>· {days} ngày</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatVnd(r.totalVnd)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatVnd(r.paidVnd)}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-[var(--warn)]">{formatVnd(r.balanceVnd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">Ghi nhận tiền khách trả ở trang đơn bán (nút “Thu thêm”) — sổ quỹ tự cập nhật.</p>
      </section>

      <section aria-labelledby="phai-tra">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 id="phai-tra" className="font-semibold">
            Phải trả
          </h2>
          <span className="text-sm tabular-nums" data-testid="payable-total">
            {formatVnd(debts.payableVnd)} ₫ · {debts.payables.length} khoản
          </span>
        </div>
        <p className="mt-1 text-sm text-muted">Đơn mua, cước vận chuyển và chi phí bán hàng chưa ghi ngày trả. Bấm “Đã trả” để ghi vào sổ quỹ.</p>
        <div className="mt-2">
          {debts.payables.length === 0 ? (
            <Empty>Không có khoản phải trả.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {debts.payables.map((p) => (
                <li key={`${p.kind}-${p.id}`} className="card p-4" data-testid="payable" aria-label={p.label}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="chip">{KIND_LABEL[p.kind]}</span>
                    <Link href={p.href} className="text-primary">
                      {p.label}
                    </Link>
                    {p.party && <span className="text-sm text-muted">{p.party}</span>}
                    {p.isEstimate && <span className="text-xs text-[var(--warn)]">dự toán</span>}
                    <span className="ml-auto font-semibold tabular-nums">{formatVnd(p.amountVnd)} ₫</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {dmy(p.date)} · {daysBetween(p.date, today)} ngày
                  </p>
                  {accOpts.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm text-muted">Đã trả…</summary>
                      <ActionForm action={markPaidAction} label={`Trả ${p.label}`} className="field-row mt-2">
                        <input type="hidden" name="kind" value={p.kind} />
                        <input type="hidden" name="id" value={p.id} />
                        <Select label="Trả từ tài khoản" name="accountId" options={accOpts} className="min-w-40" />
                        <Input label="Ngày trả" name="paidAt" type="date" defaultValue={today} className="w-40" />
                        <Submit>Ghi đã trả</Submit>
                      </ActionForm>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
