import Link from "next/link";
import { notFound } from "next/navigation";
import { formatVnd } from "@/domain/costing";
import { BATCH_STATUS_LABEL, type GridRow } from "@/domain/purchasing";
import { LEG_LABEL, type LegType } from "@/domain/catalog";
import { costBreakdown, costTargets, listCosts } from "@/server/costs/service";
import { getBatch, purchaseOptions, variantRefs, type PurchaseOrderRow } from "@/server/purchasing/service";
import { CostSection } from "../../_components/CostSection";
import { ActionForm, Input, Select, Submit } from "../../_components/form";
import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import { deleteBatchAction, deletePurchaseOrderAction, finalizeBatchAction, reopenBatchAction, savePurchaseOrderAction, updateBatchAction } from "../actions";
import { ItemGrid, type SavedInfo } from "./ItemGrid";

export const metadata = { title: "Chi tiết chuyến hàng" };

const FINAL = ["COSTS_FINALIZED", "CLOSED"];
const dmy = (d: string | null) => (d ? d.split("-").reverse().join("/") : "—");
const num = (s: string) => Number(s).toLocaleString("vi-VN", { maximumFractionDigits: 4 });
const usd = (s: string) => Number(s).toLocaleString("en-US", { style: "currency", currency: "USD" });
const todayVn = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

/** Khoá phiên bản của lưới: đổi khi dữ liệu máy đã lưu đổi → lưới nạp lại sau khi lưu. */
function version(po: PurchaseOrderRow) {
  const s = JSON.stringify(
    po.items.map((i) => [i.id, i.unitPrice, i.serial, i.imei1, i.imei2, i.partNumber, i.variantId, i.condition, i.weightKg, i.note, `${i.landedCostVnd}`]),
  );
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return `${po.id}:${(h >>> 0).toString(36)}`;
}

type Opt = readonly (readonly [string, string])[];
function PoFields({
  po,
  batchId,
  plannedFxRate,
  suppliers,
  accounts,
}: {
  po?: PurchaseOrderRow;
  batchId: string;
  plannedFxRate: string | null;
  suppliers: Opt;
  accounts: Opt;
}) {
  return (
    <>
      <input type="hidden" name="batchId" value={batchId} />
      {po && <input type="hidden" name="id" value={po.id} />}
      <Select label="Nơi mua *" name="supplierId" options={suppliers} defaultValue={po?.supplierId ?? ""} className="min-w-48" />
      <Input label="Mã đơn" name="orderNumber" defaultValue={po?.orderNumber ?? ""} placeholder="W123456789" className="w-40" />
      <Input label="Ngày đặt *" name="orderedAt" type="date" defaultValue={po?.orderedAt ?? todayVn()} className="w-40" />
      <Select
        label="Tiền tệ"
        name="currency"
        options={[
          ["USD", "USD"],
          ["VND", "VND"],
        ]}
        defaultValue={po?.currency ?? "USD"}
      />
      <Input label="Subtotal *" name="subtotal" inputMode="decimal" defaultValue={po ? po.subtotal : ""} placeholder="2,047.00" className="w-32" />
      <Input label="Sales tax" name="salesTax" inputMode="decimal" defaultValue={po && Number(po.salesTax) ? po.salesTax : ""} className="w-28" />
      <Input
        label="Ship người bán"
        name="sellerShipping"
        inputMode="decimal"
        defaultValue={po && Number(po.sellerShipping) ? po.sellerShipping : ""}
        className="w-28"
      />
      <Input
        label="Giảm giá"
        name="discount"
        inputMode="decimal"
        defaultValue={po && Number(po.discount) ? po.discount : ""}
        className="w-28"
        hint="coupon, gift card"
      />
      <Input
        label="Tỷ giá thực tế *"
        name="fxRate"
        inputMode="decimal"
        defaultValue={po ? num(po.fxRate) : plannedFxRate ? num(plannedFxRate) : ""}
        placeholder="26.400"
        className="w-32"
        hint="theo sao kê thẻ"
      />
      <Input
        label="Phí đổi ngoại tệ (₫)"
        name="fxFeeVnd"
        inputMode="numeric"
        defaultValue={po && Number(po.fxFeeVnd) ? num(po.fxFeeVnd) : ""}
        className="w-36"
      />
      <Select label="Thanh toán bằng" name="paymentAccountId" options={accounts} defaultValue={po?.paymentAccountId ?? ""} className="min-w-44" />
      <Input label="Ngày thanh toán" name="paidAt" type="date" defaultValue={po?.paidAt ?? ""} className="w-40" />
      <Input
        label="Hạn đổi trả"
        name="returnDeadline"
        type="date"
        defaultValue={po?.returnDeadline ?? ""}
        className="w-40"
        hint="Trống: tự tính theo nơi mua"
      />
      <Input label="Ghi chú" name="note" defaultValue={po?.note ?? ""} className="basis-full" />
    </>
  );
}

export default async function BatchPage({ params }: PageProps<"/chuyen-hang/[id]">) {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-6xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const batch = await getBatch(db, id);
  if (!batch) notFound();
  const [variants, options, costs, breakdown, targets] = await Promise.all([
    variantRefs(
      db,
      batch.orders.flatMap((o) => o.items.map((i) => i.variantId)),
    ),
    purchaseOptions(db),
    listCosts(db, { batchId: batch.id }),
    costBreakdown(db, batch.id),
    costTargets(db, batch.id),
  ]);
  const s = batch.summary;
  const finalized = FINAL.includes(batch.status);
  const hasEstimate = batch.orders.some((o) => o.items.some((i) => i.hasEstimate));
  const profitLabel = finalized && !hasEstimate ? "Chốt" : "Tạm tính";

  const supplierOptions = [["", "— chọn nơi mua —"] as const, ...options.suppliers.map((x) => [x.id, x.name] as const)];
  const accountOptions = [["", "— chưa chọn —"] as const, ...options.accounts.map((a) => [a.id, `${a.name} (${a.currency})`] as const)];

  const costTargetOptions = [
    [`BATCH:${batch.id}`, `Cả chuyến ${batch.code}`] as const,
    ...targets.purchaseOrders.map((p) => [`PURCHASE_ORDER:${p.id}`, `Đơn ${p.label}`] as const),
    ...targets.shipments.map((x) => [`SHIPMENT:${x.id}`, `Kiện ${x.label} (${LEG_LABEL[x.leg as LegType]})`] as const),
    ...batch.orders.flatMap((o) => o.items.map((i) => [`ITEM:${i.id}`, `Máy ${i.serial ?? i.imei1 ?? i.variantLabel}`] as const)),
  ];
  const groups = [
    ["A. Giá mua (đơn giá, thuế, ship người bán, giảm giá, phí thẻ)", breakdown.purchaseVnd],
    ["B. Nội địa Mỹ", breakdown.usDomesticVnd],
    ["C. Mỹ → VN (cước, bảo hiểm, thông quan)", breakdown.internationalVnd],
    ["D. HN → SG", breakdown.hnSgVnd],
    ["E. Khác (phí chuyển tiền, kiểm máy, lưu kho…)", breakdown.otherVnd],
  ] as const;
  const extraPct = breakdown.totalVnd > 0n ? Number(((breakdown.totalVnd - breakdown.purchaseVnd) * 10000n) / breakdown.totalVnd) / 100 : 0;
  const reconciled = breakdown.purchaseVnd === breakdown.purchaseOrdersVnd;

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <Link href="/chuyen-hang" className="text-sm text-muted hover:text-text">
        ← Chuyến hàng
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{batch.code}</h1>
        {batch.name && <span className="text-muted">{batch.name}</span>}
        <span
          className={`text-xs rounded-full px-2 py-0.5 ${finalized ? "bg-primary text-[var(--primary-text)]" : "border border-border"}`}
          data-testid="batch-status"
        >
          {BATCH_STATUS_LABEL[batch.status] ?? batch.status}
          {finalized ? " ✓" : ""}
        </span>
      </div>

      <section aria-label="Tổng hợp chuyến" className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Tổng vốn", `${formatVnd(s.totalLandedCostVnd)} ₫`, `${s.itemCount} máy · ${batch.orders.length} đơn`],
          ["Doanh thu", `${formatVnd(s.revenueVnd)} ₫`, `${s.soldCount} máy đã bán`],
          [
            `Lãi (${profitLabel})`,
            `${formatVnd(s.realizedProfitVnd)} ₫`,
            s.roiOnSoldPct ? `ROI ${s.roiOnSoldPct.replace(".", ",")}% trên vốn đã bán` : "chưa bán máy nào",
          ],
          ["Vốn còn đọng", `${formatVnd(s.unsoldCostVnd)} ₫`, `${s.itemCount - s.soldCount} máy chưa bán`],
          ["Tỷ giá dự kiến", batch.plannedFxRate ? num(batch.plannedFxRate) : "—", "giá vốn theo tỷ giá thực tế từng đơn"],
        ].map(([label, value, sub]) => (
          <div key={label} className="card p-3">
            <div className="text-xs text-muted">{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
            <div className="text-xs text-muted">{sub}</div>
          </div>
        ))}
      </section>

      <section className="mt-4 flex flex-wrap items-start gap-3" aria-label="Chốt chi phí">
        {finalized ? (
          <ActionForm action={reopenBatchAction} label="Mở lại chuyến" className="field-row">
            <input type="hidden" name="id" value={batch.id} />
            <Input label="Lý do mở lại *" name="reason" placeholder="vd: hoá đơn cước điều chỉnh" className="min-w-64" />
            <Submit variant="secondary">Mở lại chuyến</Submit>
          </ActionForm>
        ) : (
          <ActionForm
            action={finalizeBatchAction}
            label="Chốt chi phí"
            confirm={`Chốt chi phí chuyến ${batch.code}? Sau khi chốt, mọi sửa đổi làm đổi giá vốn sẽ bị chặn.`}
          >
            <input type="hidden" name="id" value={batch.id} />
            <Submit variant="secondary">Chốt chi phí chuyến</Submit>
          </ActionForm>
        )}
        <details className="grow">
          <summary className="cursor-pointer text-sm text-muted min-h-[44px] flex items-center">Sửa thông tin chuyến</summary>
          <ActionForm action={updateBatchAction} label="Sửa thông tin chuyến" className="mt-2 field-row">
            <input type="hidden" name="id" value={batch.id} />
            <Input label="Mã chuyến" name="code" defaultValue={batch.code} className="w-40" />
            <Input label="Tên / ghi nhớ" name="name" defaultValue={batch.name ?? ""} className="grow min-w-48" />
            <Input
              label="Tỷ giá dự kiến"
              name="plannedFxRate"
              inputMode="decimal"
              defaultValue={batch.plannedFxRate ? num(batch.plannedFxRate) : ""}
              className="w-36"
            />
            <Input label="Ghi chú" name="note" defaultValue={batch.note ?? ""} className="basis-full" />
            <Submit variant="secondary">Lưu</Submit>
          </ActionForm>
          {batch.orders.length === 0 && (
            <ActionForm action={deleteBatchAction} confirm={`Xoá chuyến ${batch.code}?`} label="Xoá chuyến">
              <input type="hidden" name="id" value={batch.id} />
              <Submit variant="danger">Xoá chuyến</Submit>
            </ActionForm>
          )}
        </details>
      </section>

      <h2 className="mt-8 text-lg font-semibold">Đơn mua &amp; máy</h2>
      {options.suppliers.length === 0 && (
        <p className="card mt-2 p-4 text-sm" role="alert">
          Chưa có nơi mua nào — thêm ở{" "}
          <Link href="/danh-muc/noi-mua" className="underline">
            Danh mục → Nơi mua
          </Link>{" "}
          trước.
        </p>
      )}
      {variants.length === 0 && (
        <p className="card mt-2 p-4 text-sm" role="alert">
          Chưa có cấu hình máy nào — thêm ở{" "}
          <Link href="/danh-muc" className="underline">
            Danh mục → Mẫu máy &amp; cấu hình
          </Link>{" "}
          trước.
        </p>
      )}

      <div className="mt-3 flex flex-col gap-4">
        {batch.orders.map((po) => {
          const rows: GridRow[] = po.items.map((i) => ({
            id: i.id,
            variantId: i.variantId,
            unitPrice: i.unitPrice,
            serial: i.serial ?? "",
            imei1: i.imei1 ?? "",
            imei2: i.imei2 ?? "",
            partNumber: i.partNumber ?? "",
            modelNumber: i.modelNumber ?? "",
            condition: i.condition,
            weightKg: i.weightKg ? String(Number(i.weightKg)).replace(".", ",") : "",
            note: i.note ?? "",
          }));
          const saved: Record<string, SavedInfo> = Object.fromEntries(
            po.items.map((i) => [i.id, { status: i.status, landedCostVnd: i.landedCostVnd.toString(), hasEstimate: i.hasEstimate, locked: i.locked }]),
          );
          const label = `${po.supplierName}${po.orderNumber ? ` · ${po.orderNumber}` : ""}`;
          return (
            <article key={po.id} className="card p-4" aria-label={`Đơn mua ${label}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="font-semibold">{label}</h3>
                <span className="text-sm text-muted">
                  {dmy(po.orderedAt)} · {po.currency === "USD" ? usd(po.subtotal) : `${num(po.subtotal)} ₫`}
                  {Number(po.salesTax) ? ` + tax ${usd(po.salesTax)}` : ""}
                  {Number(po.discount) ? ` − giảm ${usd(po.discount)}` : ""} · tỷ giá {num(po.fxRate)}
                </span>
                <span className="ml-auto font-semibold tabular-nums">{formatVnd(po.totalVnd)} ₫</span>
              </div>
              {po.returnDeadline && <div className="text-xs text-muted">Hạn đổi trả {dmy(po.returnDeadline)}</div>}
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-muted">Sửa / xoá đơn mua</summary>
                <ActionForm action={savePurchaseOrderAction} label={`Sửa đơn mua ${label}`} className="mt-2 field-row">
                  <PoFields po={po} batchId={batch.id} plannedFxRate={batch.plannedFxRate} suppliers={supplierOptions} accounts={accountOptions} />
                  <Submit variant="secondary">Lưu đơn mua</Submit>
                </ActionForm>
                <ActionForm action={deletePurchaseOrderAction} confirm="Xoá đơn mua này?" label={`Xoá đơn mua ${label}`}>
                  <input type="hidden" name="id" value={po.id} />
                  <Submit variant="danger">Xoá đơn mua</Submit>
                </ActionForm>
              </details>
              <ItemGrid
                key={po.id}
                version={version(po)}
                purchaseOrderId={po.id}
                initialRows={rows}
                saved={saved}
                variants={variants}
                subtotal={po.subtotal}
                fxRate={po.fxRate}
                currency={po.currency}
              />
            </article>
          );
        })}
      </div>

      <section className="card mt-4 p-4" aria-labelledby="them-don">
        <h3 id="them-don" className="font-semibold">
          + Thêm đơn mua
        </h3>
        <ActionForm action={savePurchaseOrderAction} resetOnSuccess label="Thêm đơn mua" className="mt-3 field-row">
          <PoFields batchId={batch.id} plannedFxRate={batch.plannedFxRate} suppliers={supplierOptions} accounts={accountOptions} />
          <Submit>Thêm đơn mua</Submit>
        </ActionForm>
      </section>

      <section className="mt-8" aria-labelledby="cau-truc">
        <h2 id="cau-truc" className="text-lg font-semibold">
          Cấu trúc giá vốn
        </h2>
        <div className="card mt-2 p-4">
          <table className="w-full text-sm" aria-label="Cấu trúc giá vốn">
            <tbody>
              {groups.map(([label, v]) => {
                const pct = breakdown.totalVnd > 0n ? Number((v * 1000n) / breakdown.totalVnd) / 10 : 0;
                return (
                  <tr key={label}>
                    <td className="py-1 pr-3">{label}</td>
                    <td className="py-1 w-1/3">
                      <div className="h-2 rounded bg-primary" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} aria-hidden />
                    </td>
                    <td className="py-1 pl-3 text-right tabular-nums whitespace-nowrap">{formatVnd(v)} ₫</td>
                  </tr>
                );
              })}
              <tr className="border-t border-border font-semibold">
                <td className="pt-2">= Giá vốn chuyến{breakdown.hasEstimate ? " (còn khoản dự toán)" : ""}</td>
                <td />
                <td className="pt-2 text-right tabular-nums">{formatVnd(breakdown.totalVnd)} ₫</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            Chi phí ngoài giá mua: {extraPct.toLocaleString("vi-VN")}% tổng vốn ·{" "}
            <span className={reconciled ? "text-[var(--ok)]" : "text-[var(--warn)]"} data-testid="reconcile">
              {reconciled
                ? "Đối soát: nhóm A = Σ tổng tiền các đơn mua ✓"
                : `Đối soát: nhóm A ${formatVnd(breakdown.purchaseVnd)} ≠ Σ đơn mua ${formatVnd(breakdown.purchaseOrdersVnd)} — kiểm tra subtotal / máy chưa nhập`}
            </span>
          </p>
        </div>
      </section>

      <CostSection costs={costs} targets={costTargetOptions} accounts={accountOptions} title="Chi phí của chuyến" />
    </main>
  );
}
