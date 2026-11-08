import Link from "next/link";
import { notFound } from "next/navigation";
import { formatVnd } from "@/domain/costing";
import { CONDITION_LABEL, ITEM_STATUS_LABEL, type Condition } from "@/domain/purchasing";
import { LEG_RULES } from "@/domain/shipping";
import { getItemProfile } from "@/server/sales/service";
import { GAP_LABEL } from "@/domain/attachments";
import { itemDossier } from "@/server/attachments/service";
import { Attachments } from "../../_components/Attachments";
import { HistoryLink } from "../../_components/HistoryLink";
import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import { BackLink } from "../../_components/BackLink";
import { ITEM_TONE } from "../../_components/tones";

export const metadata = { title: "Hồ sơ máy" };

const COMPONENT_LABEL: Record<string, string> = {
  PRICE: "Đơn giá",
  SALES_TAX: "Sales tax",
  SELLER_SHIPPING: "Ship người bán",
  DISCOUNT: "Giảm giá",
  PO_FX_FEE: "Phí đổi ngoại tệ",
  US_DOMESTIC_SHIPPING: "Ship nội địa Mỹ",
  INTL_SHIPPING: "Cước Mỹ → VN",
  INSURANCE: "Bảo hiểm / phụ thu",
  CUSTOMS_TAX: "Thuế thông quan",
  DOMESTIC_SHIPPING: "Cước HN → SG",
  FX_FEE: "Phí chuyển tiền",
  HANDLING: "Kiểm máy, lưu kho",
  OTHER_LANDED: "Chi phí khác",
};
const MILESTONE: Record<string, string> = {
  ORDERED: "M1 · Đặt hàng",
  ...Object.fromEntries(
    Object.values(LEG_RULES).flatMap((r) => [
      [r.departEvent, `${r.departMilestone} · ${r.departLabel}`],
      [r.arriveEvent, `${r.arriveMilestone} · ${r.arriveLabel}`],
    ]),
  ),
  RESERVED: "Khách cọc",
  SOLD: "M8 · Bán",
  DELIVERED: "M9 · Giao khách",
  RETURNED_BY_CUSTOMER: "Khách trả lại",
  NOTE: "Ghi chú",
};
const dmyHm = (ts: string) =>
  new Date(ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "short",
    timeStyle: "short",
  });

export default async function ItemProfilePage({ params }: PageProps<"/kho/[id]">) {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [p, dossier] = await Promise.all([getItemProfile(db, id), itemDossier(db, id)]);
  if (!p) notFound();
  const code = p.serial ?? p.imei1;
  const sellable = ["IN_STOCK", "ORDERED", "US_IN_TRANSIT", "AT_US_WAREHOUSE", "INTL_IN_TRANSIT", "AT_HN", "DOMESTIC_IN_TRANSIT"].includes(p.status);

  return (
    <main className="mx-auto max-w-3xl p-4 md:p-8">
      <BackLink href="/kho">Kho máy</BackLink>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{p.label}</h1>
        <span data-testid="item-status" className="badge" data-tone={ITEM_TONE[p.status] ?? "muted"}>
          {ITEM_STATUS_LABEL[p.status] ?? p.status}
        </span>
        {sellable && code && (
          <Link href={`/ban-hang/moi?code=${encodeURIComponent(code)}`} className="btn-primary ml-auto">
            Bán máy này
          </Link>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
        <div>
          <dt className="text-muted">Serial</dt>
          <dd className="font-mono">{p.serial ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">IMEI</dt>
          <dd className="font-mono">{[p.imei1, p.imei2].filter(Boolean).join(" · ") || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Part No. · SKU</dt>
          <dd className="font-mono">
            {p.partNumber ?? "—"} · {p.sku}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Tình trạng</dt>
          <dd>{CONDITION_LABEL[p.condition as Condition] ?? p.condition}</dd>
        </div>
        <div>
          <dt className="text-muted">Mua ở</dt>
          <dd>
            {p.supplier}
            {p.orderNumber ? ` · ${p.orderNumber}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Chuyến</dt>
          <dd>
            <Link href={`/chuyen-hang/${p.batch.id}`} className="underline">
              {p.batch.code}
            </Link>
          </dd>
        </div>
      </dl>

      {dossier && (
        <section className="card mt-5 p-4" aria-labelledby="ho-so" data-testid="dossier">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 id="ho-so" className="font-semibold">
              Hồ sơ nguồn gốc
            </h2>
            {dossier.gaps.length === 0 ? (
              <span className="badge" data-tone="ok" data-testid="dossier-status">
                đủ chứng từ mua và nhập khẩu
              </span>
            ) : (
              <span className="badge" data-tone="warn" data-testid="dossier-status">
                {dossier.gaps.map((g) => GAP_LABEL[g]).join(", ")}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            Hàng nhập khẩu lưu thông phải có hoá đơn, chứng từ kèm theo. Khi bị kiểm tra, mở trang này để xuất trình toàn bộ chứng từ của máy.
          </p>
          <div className="mt-3 flex flex-col divide-y divide-[var(--border)]">
            {dossier.sections.map((sec) => (
              <div key={`${sec.entityType}-${sec.entityId}`} className="py-3 first:pt-0 last:pb-0">
                <Attachments entityType={sec.entityType} entityId={sec.entityId} docs={sec.docs} title={sec.title} />
                {sec.entityType !== "ITEM" && (
                  <Link href={sec.href} className="text-xs text-muted underline">
                    Mở {sec.title.split(" ")[0].toLowerCase()}
                  </Link>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card mt-5 p-4" aria-labelledby="gia-von">
        <h2 id="gia-von" className="font-semibold">
          Giá vốn về tay: {formatVnd(p.landedCostVnd)} ₫
        </h2>
        <table className="mt-2 w-full text-sm" aria-label="Thành phần giá vốn">
          <tbody>
            {p.components.map((c, k) => (
              <tr key={k} className="border-t border-border">
                <td className="py-1">
                  {COMPONENT_LABEL[c.component] ?? c.component}
                  {c.description ? <span className="text-muted"> · {c.description}</span> : null}
                  {c.isEstimate ? <span className="text-[var(--warn)]"> · dự toán</span> : null}
                </td>
                <td className="py-1 text-right tabular-nums">{formatVnd(c.amountVnd)} ₫</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">
          Đơn giá {p.currency === "USD" ? `$${Number(p.unitPrice).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : `${p.unitPrice} ₫`} · tỷ giá đơn{" "}
          {Number(p.fxRate).toLocaleString("vi-VN")}
        </p>
      </section>

      <section className="card mt-5 p-4" aria-labelledby="dong-thoi-gian">
        <h2 id="dong-thoi-gian" className="font-semibold">
          Dòng thời gian
        </h2>
        <ol className="timeline mt-3 text-sm" data-order="asc" aria-label="Mốc thời gian">
          {p.events.map((e, k) => (
            <li key={k}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <b className="font-semibold">{MILESTONE[e.type] ?? e.type}</b>
                <span className="text-xs tabular-nums text-muted">{dmyHm(e.at)}</span>
              </div>
              {(e.tracking || e.sale_code || e.note) && (
                <div className="mt-0.5 text-xs text-muted">
                  {[e.tracking && `kiện ${e.tracking}`, e.sale_code && `đơn ${e.sale_code}`, e.note].filter(Boolean).join(" · ")}
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>

      {p.sales.length > 0 && (
        <section className="card mt-5 p-4" aria-labelledby="ban">
          <h2 id="ban" className="font-semibold">
            Bán hàng &amp; bảo hành
          </h2>
          <ul className="mt-2 text-sm">
            {p.sales.map((s) => (
              <li key={s.sale_id} className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border py-2 first:border-0">
                <Link href={`/ban-hang/${s.sale_id}`} className="font-medium text-primary hover:underline">
                  {s.code}
                </Link>
                <span>{formatVnd(s.priceVnd)} ₫</span>
                {s.profitVnd !== null && <span className={s.profitVnd < 0n ? "text-danger" : "text-[var(--ok)]"}>lãi {formatVnd(s.profitVnd)} ₫</span>}
                {s.warranty && <span className="text-muted">BH đến {s.warranty.split("-").reverse().join("/")}</span>}
                {s.voided_at && <span className="text-danger">đã trả lại / huỷ</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <HistoryLink id={id} />
    </main>
  );
}
