import Link from "next/link";
import { LEG_LABEL, type LegType } from "@/domain/catalog";
import { BOARD_COLUMNS, boardColumn, daysLate } from "@/domain/shipping";
import { listShipments, shippingOptions } from "@/server/shipping/service";
import { ActionForm, Submit } from "../_components/form";
import { catalogDb, NoDatabase } from "../danh-muc/shared";
import { createShipmentAction } from "./actions";
import { dmy, ShipmentFields, todayVn, vnd } from "./shared";

export const metadata = { title: "Vận chuyển" };

export default async function ShippingBoard() {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-6xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const [shipments, opts] = await Promise.all([listShipments(db), shippingOptions(db)]);
  const today = todayVn();
  const carriers = [["", "— chọn —"] as const, ...opts.carriers.map((c) => [c.id, c.name] as const)];
  const batches = [["", "— không / nhiều chuyến —"] as const, ...opts.batches.map((b) => [b.id, b.code] as const)];
  const lateCount = shipments.filter((s) => daysLate(s.eta, today, s.status) > 0).length;

  return (
    <main className="mx-auto max-w-[1400px] p-4 md:p-8">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-bold">Vận chuyển</h1>
        {lateCount > 0 && <span className="text-sm text-danger">⚠ {lateCount} kiện quá ngày dự kiến</span>}
      </div>
      <p className="mt-1 text-sm text-muted">
        Mỗi thẻ là một kiện. Bấm &quot;Gửi đi&quot; / &quot;Đã nhận&quot; trong kiện — hệ thống tự ghi mốc cho mọi máy bên trong.
      </p>

      <details className="card mt-4 p-4">
        <summary className="cursor-pointer font-semibold">+ Tạo kiện</summary>
        <ActionForm action={createShipmentAction} label="Tạo kiện" className="mt-3 field-row">
          <ShipmentFields carriers={carriers} batches={batches} />
          <Submit>Tạo kiện</Submit>
        </ActionForm>
      </details>

      <div className="mt-5 flex gap-3 overflow-x-auto pb-3" role="list" aria-label="Bảng tiến độ">
        {BOARD_COLUMNS.map((col) => {
          const cards = shipments.filter((s) => boardColumn(s) === col.key);
          if (col.key === "OTHER" && !cards.length) return null;
          return (
            <section key={col.key} role="listitem" aria-label={col.label} className="w-64 shrink-0 rounded-xl bg-[var(--surface)] border border-border p-2">
              <h2 className="px-1 py-1 text-sm font-semibold">
                {col.label} <span className="text-muted font-normal">({cards.length})</span>
              </h2>
              <div className="flex flex-col gap-2">
                {cards.map((s) => {
                  const late = daysLate(s.eta, today, s.status);
                  return (
                    <Link
                      key={s.id}
                      href={`/van-chuyen/${s.id}`}
                      className={`block rounded-xl border p-2.5 text-sm hover:border-primary ${late ? "border-[var(--danger)]" : "border-border"} bg-[var(--fill)]`}
                      aria-label={`Kiện ${s.trackingNumber ?? s.referenceCode ?? "chưa có mã"}`}
                    >
                      <div className="font-mono text-xs truncate">{s.trackingNumber ?? s.referenceCode ?? "(chưa có mã)"}</div>
                      <div className="mt-0.5">
                        {s.carrierName ?? "—"} · {s.itemCount} máy
                      </div>
                      {col.key === "PLANNED" || col.key === "ARRIVED" ? <div className="text-xs text-muted">{LEG_LABEL[s.legType as LegType]}</div> : null}
                      <div className="text-xs text-muted">
                        {s.batchCodes.join(", ") || "—"} · {vnd(s.valueVnd)} ₫
                      </div>
                      {s.status === "HOLD" && <div className="mt-1 text-xs font-semibold text-danger">⛔ GIỮ HẢI QUAN</div>}
                      {s.status === "ARRIVED" ? (
                        <div className="text-xs text-[var(--ok)]">✓ nhận {dmy(s.arrivedAt)}</div>
                      ) : s.eta ? (
                        <div className={`text-xs ${late ? "text-danger font-semibold" : "text-muted"}`}>
                          ETA {dmy(s.eta)}
                          {late ? ` · trễ ${late} ngày` : ""}
                        </div>
                      ) : null}
                    </Link>
                  );
                })}
                {cards.length === 0 && <p className="px-1 py-3 text-xs text-muted">Trống</p>}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
