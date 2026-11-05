import Link from "next/link";
import { notFound } from "next/navigation";
import { LEG_LABEL, type LegType } from "@/domain/catalog";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing";
import { daysLate, isMainLeg, isoToVnLocal, LEG_RULES, SHIPMENT_STATUS_LABEL, trackingUrl } from "@/domain/shipping";
import { KINDS_BY_LEG } from "@/domain/costs";
import { listCosts } from "@/server/costs/service";
import { getShipment, shippingOptions } from "@/server/shipping/service";
import { CostSection } from "../../_components/CostSection";
import { ActionForm, Input, Submit } from "../../_components/form";
import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import { arriveAction, assignAction, deleteShipmentAction, holdAction, removeItemAction, shipAction, updateShipmentAction } from "../actions";
import { dmy, ShipmentFields, todayVn, vnd } from "../shared";
import { ScanBox } from "./ScanBox";

export const metadata = { title: "Kiện vận chuyển" };

const dmyHm = (ts: string | null) => {
  if (!ts) return "—";
  const vn = isoToVnLocal(new Date(ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")));
  return `${dmy(vn.slice(0, 10))} ${vn.slice(11, 16)}`;
};

export default async function ShipmentPage({ params }: PageProps<"/van-chuyen/[id]">) {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-5xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await getShipment(db, id);
  if (!s) notFound();
  const [opts, costs, accounts] = await Promise.all([
    shippingOptions(db),
    listCosts(db, { shipmentId: s.id }),
    db<{ id: string; name: string; currency: string }[]>`SELECT id::text, name, currency::text FROM accounts WHERE is_active ORDER BY name`,
  ]);
  const accountOptions = [["", "— chưa chọn —"] as const, ...accounts.map((a) => [a.id, `${a.name} (${a.currency})`] as const)];
  const carriers = [["", "— chọn —"] as const, ...opts.carriers.filter((c) => c.legTypes.includes(s.legType)).map((c) => [c.id, c.name] as const)];
  const batches = [["", "— không / nhiều chuyến —"] as const, ...opts.batches.map((b) => [b.id, b.code] as const)];
  const rule = isMainLeg(s.legType) ? LEG_RULES[s.legType] : null;
  const late = daysLate(s.eta, todayVn(), s.status);
  const link = trackingUrl(s.trackingTemplate, s.trackingNumber);
  const now = isoToVnLocal(new Date());
  const title = s.trackingNumber ?? s.referenceCode ?? "Kiện chưa có mã";

  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <Link href="/van-chuyen" className="text-sm text-muted hover:text-text">
        ← Vận chuyển
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold font-mono">{title}</h1>
        <span className="text-sm">{LEG_LABEL[s.legType as LegType]}</span>
        <span
          data-testid="shipment-status"
          className={`text-xs rounded-full px-2 py-0.5 ${s.status === "HOLD" ? "bg-[var(--danger)] text-[var(--surface-solid)]" : s.status === "ARRIVED" ? "bg-primary text-[var(--primary-text)]" : "bg-[var(--fill)]"}`}
        >
          {SHIPMENT_STATUS_LABEL[s.status] ?? s.status}
        </span>
        {late > 0 && <span className="text-sm font-semibold text-danger">⚠ trễ {late} ngày so với dự kiến</span>}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
        <div>
          <dt className="text-muted">Đơn vị</dt>
          <dd>{s.carrierName ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Gửi đi{rule ? ` (${rule.departMilestone})` : ""}</dt>
          <dd>{dmyHm(s.shippedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Dự kiến nhận</dt>
          <dd>{dmy(s.eta)}</dd>
        </div>
        <div>
          <dt className="text-muted">Đã nhận{rule ? ` (${rule.arriveMilestone})` : ""}</dt>
          <dd>{dmyHm(s.arrivedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Máy · giá trị</dt>
          <dd>
            {s.itemCount} máy · {vnd(s.valueVnd)} ₫
          </dd>
        </div>
        <div>
          <dt className="text-muted">Chuyến</dt>
          <dd>{s.batchCodes.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Mã bill / AWB</dt>
          <dd>{s.referenceCode ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Tra cứu</dt>
          <dd>
            {link ? (
              <a href={link} target="_blank" rel="noreferrer noopener" className="underline">
                Mở trang vận đơn ↗
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      <section className="mt-5 field-row" aria-label="Thao tác kiện">
        {s.status === "PLANNED" && (
          <ActionForm action={shipAction} label="Gửi đi" className="field-row">
            <input type="hidden" name="id" value={s.id} />
            <Input label={`Ngày giờ gửi${rule ? ` — ${rule.departLabel}` : ""}`} name="at" type="datetime-local" defaultValue={now} className="w-56" />
            <Submit>Gửi đi</Submit>
          </ActionForm>
        )}
        {(s.status === "IN_TRANSIT" || s.status === "HOLD") && (
          <ActionForm action={arriveAction} label="Đã nhận" className="field-row">
            <input type="hidden" name="id" value={s.id} />
            <Input label={`Ngày giờ nhận${rule ? ` — ${rule.arriveLabel}` : ""}`} name="at" type="datetime-local" defaultValue={now} className="w-56" />
            <Submit>Đã nhận</Submit>
          </ActionForm>
        )}
        {s.status === "IN_TRANSIT" && (
          <ActionForm action={holdAction} label="Giữ hải quan" className="field-row">
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="hold" value="1" />
            <Input label="Lý do giữ" name="note" className="w-48" />
            <Submit variant="secondary">Giữ hải quan</Submit>
          </ActionForm>
        )}
        {s.status === "HOLD" && (
          <ActionForm action={holdAction} label="Hết giữ hải quan">
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="hold" value="0" />
            <Submit variant="secondary">Hết giữ hải quan</Submit>
          </ActionForm>
        )}
      </section>

      {s.status !== "ARRIVED" && s.status !== "CANCELLED" && (
        <section className="card mt-5 p-4" aria-labelledby="quet-may">
          <h2 id="quet-may" className="font-semibold">
            Quét máy vào kiện
          </h2>
          <ActionForm action={assignAction} resetOnSuccess label="Quét máy vào kiện" className="mt-2 field-row">
            <input type="hidden" name="id" value={s.id} />
            <ScanBox label="Serial / IMEI (máy quét USB, camera điện thoại gõ vào, hoặc dán danh sách)" />
            <Submit>Thêm vào kiện</Submit>
          </ActionForm>
          {s.status !== "PLANNED" && <p className="mt-2 text-xs text-muted">Kiện đã gửi: máy thêm vào sẽ nhận luôn mốc gửi đi của kiện.</p>}
        </section>
      )}

      <section className="mt-5" aria-labelledby="ds-may">
        <h2 id="ds-may" className="text-lg font-semibold">
          Máy trong kiện <span className="text-sm font-normal text-muted">· {s.items.length}</span>
        </h2>
        {s.items.length === 0 ? (
          <p className="card mt-2 p-4 text-sm text-muted">Chưa có máy — quét Serial / IMEI ở trên.</p>
        ) : (
          <div className="card mt-2 overflow-x-auto">
            <table className="w-full text-sm" aria-label="Máy trong kiện">
              <thead className="text-left text-muted">
                <tr>
                  <th className="p-2 font-medium">Máy</th>
                  <th className="p-2 font-medium">Serial / IMEI</th>
                  <th className="p-2 font-medium">Chuyến</th>
                  <th className="p-2 font-medium">Trạng thái</th>
                  <th className="p-2 font-medium text-right">Giá vốn</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {s.items.map((i) => (
                  <tr key={i.id} className="border-t border-border" aria-label={i.serial ?? i.imei1 ?? i.id}>
                    <td className="p-2">
                      <Link href={`/kho/${i.id}`} className="underline">
                        {i.label}
                      </Link>
                    </td>
                    <td className="p-2 font-mono text-xs">
                      {i.serial ?? "—"}
                      <br />
                      {i.imei1 ?? ""}
                    </td>
                    <td className="p-2">
                      <Link href={`/chuyen-hang/${i.batchId}`} className="underline">
                        {i.batchCode}
                      </Link>
                    </td>
                    <td className="p-2">{ITEM_STATUS_LABEL[i.status] ?? i.status}</td>
                    <td className="p-2 text-right tabular-nums">{vnd(i.landedCostVnd)} ₫</td>
                    <td className="p-2 text-right">
                      {s.status === "PLANNED" && (
                        <ActionForm action={removeItemAction} label={`Bỏ ${i.serial ?? i.imei1} khỏi kiện`}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="itemId" value={i.id} />
                          <Submit variant="danger">Bỏ</Submit>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CostSection
        costs={costs}
        targets={[[`SHIPMENT:${s.id}`, `Kiện ${title}`]]}
        defaultTarget={`SHIPMENT:${s.id}`}
        accounts={accountOptions}
        kinds={KINDS_BY_LEG[s.legType] ?? []}
        title="Chi phí của kiện"
      />

      <details className="mt-6">
        <summary className="cursor-pointer text-sm text-muted">Sửa thông tin kiện{s.status === "PLANNED" ? " / xoá kiện" : ""}</summary>
        <ActionForm action={updateShipmentAction} label="Sửa thông tin kiện" className="mt-3 field-row">
          <input type="hidden" name="id" value={s.id} />
          <input type="hidden" name="legType" value={s.legType} />
          <ShipmentFields carriers={carriers} batches={batches} withLeg={false} s={s} />
          <Submit variant="secondary">Lưu</Submit>
        </ActionForm>
        {s.status === "PLANNED" && (
          <ActionForm action={deleteShipmentAction} confirm="Xoá kiện này?" label="Xoá kiện">
            <input type="hidden" name="id" value={s.id} />
            <Submit variant="danger">Xoá kiện</Submit>
          </ActionForm>
        )}
      </details>
    </main>
  );
}
