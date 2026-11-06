import Link from "next/link";
import { LEG_LABEL, type LegType } from "@/domain/catalog";
import { BOARD_COLUMNS, boardColumn, daysLate } from "@/domain/shipping";
import { listShipments, listShortages, shippingOptions } from "@/server/shipping/service";
import { ActionForm, Submit } from "../_components/form";
import { Glyph } from "../_components/Glyph";
import { catalogDb, NoDatabase } from "../danh-muc/shared";
import { createShipmentAction } from "./actions";
import { dmy, ShipmentFields, todayVn, TrackBadge, TrackLinkForm, vnd } from "./shared";

export const metadata = { title: "Vận chuyển" };

export default async function ShippingBoard() {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-6xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const [shipments, opts, shortages] = await Promise.all([listShipments(db), shippingOptions(db), listShortages(db)]);
  const today = todayVn();
  const carriers = [["", "— chọn —"] as const, ...opts.carriers.map((c) => [c.id, c.name] as const)];
  const batches = [["", "— không / nhiều chuyến —"] as const, ...opts.batches.map((b) => [b.id, b.code] as const)];
  const lateCount = shipments.filter((s) => daysLate(s.eta, today, s.status) > 0).length;
  const shortBy = new Map<string, { tracking: string | null; n: number }>();
  for (const m of shortages) shortBy.set(m.shipmentId, { tracking: m.tracking, n: (shortBy.get(m.shipmentId)?.n ?? 0) + 1 });

  return (
    <main className="mx-auto max-w-[1400px] p-4 md:p-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl font-bold">Vận chuyển</h1>
        {lateCount > 0 && (
          <span className="badge" data-tone="danger">
            {lateCount} kiện quá ngày dự kiến
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Mỗi thẻ là một kiện. Bấm &quot;Gửi đi&quot; / &quot;Đã nhận&quot; trong kiện — hệ thống tự ghi mốc cho mọi máy bên trong.
      </p>
      {shortBy.size > 0 && (
        <div className="callout mt-3" data-tone="danger" role="note">
          <Glyph name="warn" size={17} />
          <p>
            <strong className="text-danger">Sự cố thiếu hàng:</strong> {shortages.length} máy chưa về —{" "}
            {[...shortBy].map(([id, x], k) => (
              <span key={id}>
                {k > 0 && ", "}
                <Link href={`/van-chuyen/${id}`} className="font-medium underline">
                  kiện {x.tracking ?? "chưa có mã"} ({x.n})
                </Link>
              </span>
            ))}
          </p>
        </div>
      )}

      <section className="card mt-4 p-4 md:p-5" aria-labelledby="bot-link">
        <div className="flex items-start gap-3">
          <span className="icon-tile">
            <Glyph name="bot" size={20} />
          </span>
          <div className="min-w-0">
            <h2 id="bot-link" className="font-semibold">
              Bot theo dõi vận đơn
            </h2>
            <p className="mt-0.5 text-xs text-muted">Dán link UPS / USPS / FedEx / DHL — bot tự nhận hãng, tạo kiện và kiểm tra lúc 07:00 và 19:00 mỗi ngày.</p>
          </div>
        </div>
        <div className="mt-3">
          <TrackLinkForm />
        </div>
      </section>

      <details className="card mt-4 p-4">
        <summary className="cursor-pointer font-semibold">+ Tạo kiện</summary>
        <ActionForm action={createShipmentAction} label="Tạo kiện" className="mt-3 field-row">
          <ShipmentFields carriers={carriers} batches={batches} />
          <Submit>Tạo kiện</Submit>
        </ActionForm>
      </details>

      <div className="-mx-4 mt-5 flex snap-x gap-3 overflow-x-auto px-4 pb-3 md:mx-0 md:px-0" role="list" aria-label="Bảng tiến độ">
        {BOARD_COLUMNS.map((col) => {
          const cards = shipments.filter((s) => boardColumn(s) === col.key);
          if (col.key === "OTHER" && !cards.length) return null;
          return (
            <section key={col.key} role="listitem" aria-label={col.label} className="w-[17rem] shrink-0 snap-start rounded-[22px] bg-[var(--fill)] p-2">
              <h2 className="flex items-center justify-between px-2 pb-2 pt-1 text-sm font-semibold">
                {col.label}
                <span className="rounded-full bg-[var(--surface-strong)] px-2 py-0.5 text-xs font-medium tabular-nums text-muted">{cards.length}</span>
              </h2>
              <div className="flex flex-col gap-2">
                {cards.map((s) => {
                  const late = daysLate(s.eta, today, s.status);
                  return (
                    <Link
                      key={s.id}
                      href={`/van-chuyen/${s.id}`}
                      className={`card block rounded-2xl p-3 text-sm hover:-translate-y-0.5 ${late ? "border-[var(--danger)]" : ""}`}
                      aria-label={`Kiện ${s.trackingNumber ?? s.referenceCode ?? "chưa có mã"}`}
                    >
                      <div className="truncate font-mono text-[13px] font-medium">{s.trackingNumber ?? s.referenceCode ?? "(chưa có mã)"}</div>
                      <div className="mt-0.5 flex items-baseline justify-between gap-2">
                        <span className="truncate">{s.carrierName ?? "—"}</span>
                        <span className="shrink-0 text-xs font-medium tabular-nums">{s.itemCount} máy</span>
                      </div>
                      {col.key === "PLANNED" || col.key === "ARRIVED" ? <div className="text-xs text-muted">{LEG_LABEL[s.legType as LegType]}</div> : null}
                      <div className="truncate text-xs text-muted">
                        {s.batchCodes.join(", ") || "—"} · {vnd(s.valueVnd)} ₫
                      </div>
                      {(late > 0 || s.status === "HOLD" || (s.trackStatus && s.status !== "ARRIVED")) && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {late > 0 && (
                            <span className="badge" data-tone="danger">
                              trễ {late} ngày
                            </span>
                          )}
                          {s.status === "HOLD" && (
                            <span className="badge" data-tone="solid-danger">
                              Giữ hải quan
                            </span>
                          )}
                          {s.trackStatus && s.status !== "ARRIVED" && (
                            <TrackBadge status={s.trackStatus} testid="card-track" />
                          )}
                        </div>
                      )}
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2 text-xs">
                        {s.status === "ARRIVED" ? (
                          <span className="inline-flex items-center gap-1 font-medium text-[var(--ok)]">
                            <Glyph name="check" size={14} />
                            nhận {dmy(s.arrivedAt)}
                          </span>
                        ) : s.eta ? (
                          <span className={late ? "font-semibold text-danger" : "text-muted"}>ETA {dmy(s.eta)}</span>
                        ) : (
                          <span className="text-muted">Chưa có ETA</span>
                        )}
                        {s.trackEta && s.status !== "ARRIVED" && <span className="text-muted">hãng hẹn {dmy(s.trackEta).slice(0, 5)}</span>}
                      </div>
                    </Link>
                  );
                })}
                {cards.length === 0 && <p className="rounded-2xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted">Trống</p>}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
