import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBp, formatVnd, itemProfit } from "@/domain/costing";
import { CHANNEL_LABEL, SALE_STATUS_LABEL, type Channel } from "@/domain/sales";
import { getSale } from "@/server/sales/service";
import { ActionForm, Checkbox, Input, Select, Submit } from "../../_components/form";
import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import { addPaymentAction, cancelDepositAction, completeSaleAction, returnItemAction } from "../actions";

export const metadata = { title: "Đơn bán" };

const dmyHm = (ts: string) =>
  new Date(ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "short",
    timeStyle: "short",
  });
const dmy = (d: string | null) => (d ? d.split("-").reverse().join("/") : "—");
const CATEGORY: Record<string, string> = { SALE_DEPOSIT: "Nhận cọc", SALE_RECEIPT: "Thu tiền", SALE_REFUND: "Hoàn tiền" };
const EXPENSE: Record<string, string> = {
  SHIPPING_TO_CUSTOMER: "Ship khách",
  OTHER: "Phí khác",
  COD_FEE: "Phí COD",
  PLATFORM_FEE: "Phí sàn",
  GIFT: "Quà tặng",
};

export default async function SalePage({ params }: PageProps<"/ban-hang/[id]">) {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sale = await getSale(db, id);
  if (!sale) notFound();
  const accounts = await db<
    { id: string; name: string }[]
  >`SELECT id::text, name FROM accounts WHERE is_active AND currency = 'VND' ORDER BY kind <> 'BANK', name`;
  const accountOptions = [["", "— chọn —"] as const, ...accounts.map((a) => [a.id, a.name] as const)];
  const active = sale.lines.filter((l) => !l.voidedAt);
  const profits = active.map((l) => itemProfit({ netRevenueVnd: l.priceVnd - l.discountAllocVnd, expenseAllocVnd: l.expenseAllocVnd }, l.costVnd));
  const profit = profits.reduce((a, p) => a + p.profitVnd, 0n);
  const estimate = active.some((l) => l.hasEstimate);

  return (
    <main className="mx-auto max-w-3xl p-4 md:p-8">
      <Link href="/ban-hang" className="text-sm text-muted hover:text-text">
        ← Bán hàng
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{sale.code}</h1>
        <span data-testid="sale-status" className="text-xs rounded-full border border-border px-2 py-0.5">
          {SALE_STATUS_LABEL[sale.status] ?? sale.status}
        </span>
        <span className="text-sm text-muted">
          {dmyHm(sale.soldAt)} · {CHANNEL_LABEL[sale.channel as Channel] ?? sale.channel}
        </span>
      </div>
      <p className="mt-1 text-sm">Khách: {sale.customer ? `${sale.customer.name}${sale.customer.phone ? ` · ${sale.customer.phone}` : ""}` : "Khách lẻ"}</p>

      <section className="card mt-4 p-4" aria-label="Tổng đơn">
        <dl className="grid grid-cols-2 gap-1 text-sm">
          <dt className="text-muted">Doanh thu thuần</dt>
          <dd className="text-right tabular-nums">{formatVnd(sale.totalVnd)} ₫</dd>
          <dt className="text-muted">Đã thu</dt>
          <dd className="text-right tabular-nums">{formatVnd(sale.paidVnd)} ₫</dd>
          <dt className="font-semibold">Còn phải thu</dt>
          <dd className={`text-right font-semibold tabular-nums ${sale.balanceVnd > 0n ? "text-[var(--warn)]" : ""}`} data-testid="balance">
            {formatVnd(sale.balanceVnd)} ₫
          </dd>
          {sale.status !== "CANCELLED" && (
            <>
              <dt className="font-semibold">Lãi {sale.status === "DEPOSITED" || estimate ? "(tạm tính)" : ""}</dt>
              <dd className={`text-right font-semibold tabular-nums ${profit < 0n ? "text-danger" : "text-[var(--ok)]"}`} data-testid="sale-detail-profit">
                {formatVnd(profit)} ₫
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="mt-4" aria-label="Máy trong đơn">
        <ul className="flex flex-col gap-2">
          {sale.lines.map((l) => {
            const k = active.indexOf(l);
            const p = k >= 0 ? profits[k] : null;
            return (
              <li key={l.id} className={`card p-3 ${l.voidedAt ? "opacity-60" : ""}`} aria-label={`Máy ${l.serial ?? l.imei1}`}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <Link href={`/kho/${l.itemId}`} className="font-semibold underline">
                    {l.label}
                  </Link>
                  <span className="text-xs font-mono text-muted">{l.serial ?? l.imei1}</span>
                  {l.voidedAt && <span className="text-xs text-danger">đã trả lại / huỷ: {l.voidReason}</span>}
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-4 text-sm sm:grid-cols-4">
                  <span>Giá bán {formatVnd(l.priceVnd)} ₫</span>
                  <span>Giá vốn {formatVnd(l.costVnd)} ₫</span>
                  {p && (
                    <span className={p.profitVnd < 0n ? "text-danger" : "text-[var(--ok)]"}>
                      Lãi {formatVnd(p.profitVnd)} ₫ · {formatBp(p.marginBp)}
                    </span>
                  )}
                  <span className="text-muted">BH đến {dmy(l.warrantyUntil)}</span>
                </div>
                {l.costSnapshotVnd !== null && l.costSnapshotVnd !== l.costVnd && (
                  <p className="mt-1 text-xs text-[var(--warn)]">
                    Giá vốn đã đổi so với lúc bán ({formatVnd(l.costSnapshotVnd)} ₫ → {formatVnd(l.costVnd)} ₫) — có chi phí phát sinh sau
                  </p>
                )}
                {!l.voidedAt && sale.status === "COMPLETED" && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted">Khách trả lại máy này</summary>
                    <ActionForm
                      action={returnItemAction}
                      label={`Khách trả lại ${l.serial ?? l.imei1}`}
                      confirm="Ghi nhận khách trả lại máy này?"
                      className="mt-2 field-row"
                    >
                      <input type="hidden" name="saleItemId" value={l.id} />
                      <Input label="Lý do *" name="reason" className="min-w-48" />
                      <Input label="Hoàn tiền" name="refund" inputMode="decimal" placeholder="34,5tr" className="w-32" />
                      <Select label="Hoàn từ tài khoản" name="accountId" options={accountOptions} />
                      <Submit variant="danger">Ghi nhận trả lại</Submit>
                    </ActionForm>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {sale.expenses.length > 0 && (
          <p className="mt-2 text-sm text-muted">
            Chi phí bán hàng: {sale.expenses.map((e) => `${EXPENSE[e.kind] ?? e.kind} ${formatVnd(e.amountVnd)} ₫`).join(" · ")}
            {sale.discountVnd > 0n ? ` · giảm giá đơn ${formatVnd(sale.discountVnd)} ₫` : ""}
          </p>
        )}
      </section>

      <section className="mt-4 flex flex-col gap-3" aria-label="Thao tác đơn">
        {sale.status === "DEPOSITED" && (
          <div className="card p-4">
            <h2 className="font-semibold">Hoàn tất đơn (giao máy)</h2>
            <ActionForm action={completeSaleAction} label="Hoàn tất đơn" className="mt-2 field-row">
              <input type="hidden" name="id" value={sale.id} />
              <Input label="Thu nốt" name="paidAmount" inputMode="decimal" defaultValue={formatVnd(sale.balanceVnd)} className="w-36" />
              <Select label="Vào tài khoản" name="accountId" options={accountOptions} defaultValue={accounts[0]?.id} />
              <Input label="Bảo hành (tháng)" name="warrantyMonths" inputMode="numeric" defaultValue="6" className="w-32" />
              <Checkbox label="Bán giao thẳng (máy chưa về SG)" name="directShip" />
              <Submit>Hoàn tất</Submit>
            </ActionForm>
          </div>
        )}
        {sale.status !== "CANCELLED" && sale.balanceVnd > 0n && sale.status === "COMPLETED" && (
          <div className="card p-4">
            <h2 className="font-semibold">Thu thêm tiền</h2>
            <ActionForm action={addPaymentAction} label="Thu thêm tiền" className="mt-2 field-row">
              <input type="hidden" name="id" value={sale.id} />
              <Input label="Số tiền" name="amount" inputMode="decimal" defaultValue={formatVnd(sale.balanceVnd)} className="w-36" />
              <Select label="Vào tài khoản" name="accountId" options={accountOptions} defaultValue={accounts[0]?.id} />
              <Submit>Ghi nhận</Submit>
            </ActionForm>
          </div>
        )}
        {sale.status === "DEPOSITED" && (
          <details className="card p-4">
            <summary className="cursor-pointer text-sm text-danger">Huỷ đơn cọc</summary>
            <ActionForm action={cancelDepositAction} label="Huỷ đơn cọc" confirm="Huỷ đơn cọc này?" className="mt-2 field-row">
              <input type="hidden" name="id" value={sale.id} />
              <Input label="Lý do *" name="reason" className="min-w-48" />
              <Input label="Hoàn cọc" name="refund" inputMode="decimal" defaultValue={formatVnd(sale.paidVnd)} className="w-32" hint="0 = giữ cọc" />
              <Select label="Hoàn từ tài khoản" name="accountId" options={accountOptions} defaultValue={accounts[0]?.id} />
              <Submit variant="danger">Huỷ đơn</Submit>
            </ActionForm>
          </details>
        )}
      </section>

      {sale.payments.length > 0 && (
        <section className="mt-4" aria-labelledby="thu-chi">
          <h2 id="thu-chi" className="font-semibold">
            Thu chi của đơn
          </h2>
          <ul className="mt-2 text-sm">
            {sale.payments.map((p) => (
              <li key={p.id} className="flex gap-3 border-t border-border py-1">
                <span className="text-muted">{dmyHm(p.at)}</span>
                <span>{CATEGORY[p.category] ?? p.category}</span>
                <span className="text-muted">{p.account}</span>
                <span className={`ml-auto tabular-nums ${p.direction === "OUT" ? "text-danger" : ""}`}>
                  {p.direction === "OUT" ? "−" : "+"}
                  {formatVnd(p.amountVnd)} ₫
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
