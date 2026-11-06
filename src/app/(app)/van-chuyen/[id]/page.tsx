import Link from "next/link";
import { notFound } from "next/navigation";
import { LEG_LABEL, type LegType } from "@/domain/catalog";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing";
import { daysLate, isMainLeg, isoToVnLocal, LEG_RULES, SHIPMENT_STATUS_LABEL, trackingUrl } from "@/domain/shipping";
import { humanDuration, vnShort, type TrackStatus } from "@/domain/tracking";
import { listTrackingEvents } from "@/server/tracking/service";
import { KINDS_BY_LEG } from "@/domain/costs";
import { listCosts } from "@/server/costs/service";
import { getShipment, listShortages, shippingOptions } from "@/server/shipping/service";
import { listAttachments } from "@/server/attachments/service";
import { Attachments } from "../../_components/Attachments";
import { CostSection } from "../../_components/CostSection";
import { ActionForm, Input, Submit } from "../../_components/form";
import { Glyph } from "../../_components/Glyph";
import { HistoryLink } from "../../_components/HistoryLink";
import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import {
  arriveAction,
  assignAction,
  checkOneAction,
  labelCreatedAction,
  toggleTrackAction,
  deleteShipmentAction,
  holdAction,
  receiveLateAction,
  removeItemAction,
  shipAction,
  updateShipmentAction,
} from "../actions";
import { dmy, ShipmentFields, todayVn, TrackBadge, TzSelect, vnd } from "../shared";
import { ClearReceiveSession } from "./nhan/ReceiveClient";
import { ScanBox } from "./ScanBox";

export const metadata = { title: "Kiện vận chuyển" };

const STATUS_TONE: Record<string, string> = { PLANNED: "muted", IN_TRANSIT: "info", HOLD: "solid-danger", ARRIVED: "ok", LOST: "danger", CANCELLED: "muted" };

const dmyHm = (ts: string | null) => {
  if (!ts) return "—";
  const vn = isoToVnLocal(new Date(ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")));
  return `${dmy(vn.slice(0, 10))} ${vn.slice(11, 16)}`;
};

export default async function ShipmentPage({ params, searchParams }: PageProps<"/van-chuyen/[id]">) {
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
  const justReceived = (await searchParams).nhan === "1";
  const [opts, costs, accounts, docs, shortages, events] = await Promise.all([
    shippingOptions(db),
    listCosts(db, { shipmentId: s.id }),
    db<{ id: string; name: string; currency: string }[]>`SELECT id::text, name, currency::text FROM accounts WHERE is_active ORDER BY name`,
    listAttachments(db, "SHIPMENT", [s.id]),
    s.status === "ARRIVED" ? listShortages(db, s.id) : Promise.resolve([]),
    listTrackingEvents(db, s.id),
  ]);
  const accountOptions = [["", "— chưa chọn —"] as const, ...accounts.map((a) => [a.id, `${a.name} (${a.currency})`] as const)];
  const carriers = [["", "— chọn —"] as const, ...opts.carriers.filter((c) => c.legTypes.includes(s.legType)).map((c) => [c.id, c.name] as const)];
  const batches = [["", "— không / nhiều chuyến —"] as const, ...opts.batches.map((b) => [b.id, b.code] as const)];
  const rule = isMainLeg(s.legType) ? LEG_RULES[s.legType] : null;
  const late = daysLate(s.eta, todayVn(), s.status);
  const link = trackingUrl(s.trackingTemplate, s.trackingNumber);
  const now = isoToVnLocal(new Date());
  const title = s.trackingNumber ?? s.referenceCode ?? "Kiện chưa có mã";
  const vnIso = (ts: string | null) => (ts ? new Date(ts).toISOString() : null);
  const sellerWait =
    s.labelCreatedAt && s.shippedAt ? humanDuration(vnIso(s.labelCreatedAt)!, vnIso(s.shippedAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"))!) : null;
  // gợi ý giờ theo hãng báo (bot): gửi đi = lúc hãng nhận hàng, đã nhận = lúc hãng giao
  const shipDefault = s.trackPickedUpAt ? isoToVnLocal(new Date(s.trackPickedUpAt)) : now;
  const arriveDefault = s.trackDeliveredAt ? isoToVnLocal(new Date(s.trackDeliveredAt)) : now;
  const track = s.trackStatus as TrackStatus | null;

  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <Link href="/van-chuyen" className="text-sm text-muted hover:text-text">
        ← Vận chuyển
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="break-all font-mono text-2xl font-bold tracking-tight">{title}</h1>
        <span className="text-sm text-muted">{LEG_LABEL[s.legType as LegType]}</span>
        <span data-testid="shipment-status" className="badge" data-tone={STATUS_TONE[s.status] ?? "muted"}>
          {SHIPMENT_STATUS_LABEL[s.status] ?? s.status}
        </span>
        {late > 0 && (
          <span className="badge" data-tone="danger">
            trễ {late} ngày so với dự kiến
          </span>
        )}
      </div>

      <dl className="card mt-4 grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm md:grid-cols-4 md:p-5 [&_dt]:text-xs [&_dt]:text-muted [&_dd]:mt-0.5 [&_dd]:font-medium">
        <div>
          <dt className="text-muted">Đơn vị</dt>
          <dd>{s.carrierName ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Người bán tạo nhãn</dt>
          <dd data-testid="label-created">
            {s.labelCreatedAt ? vnShort(s.labelCreatedAt) : "—"}
            {sellerWait && <span className="block text-xs font-normal text-muted">chờ {sellerWait} mới gửi</span>}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Gửi đi{rule ? ` (${rule.departMilestone})` : ""}</dt>
          <dd>{dmyHm(s.shippedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Dự kiến nhận</dt>
          <dd>
            {dmy(s.eta)}
            {s.trackEta && (
              <span className="block text-xs font-normal text-muted">
                hãng hẹn {dmy(s.trackEta)}
                {s.trackEtaWindow ? ` ${s.trackEtaWindow}` : ""} (giờ nơi nhận)
              </span>
            )}
          </dd>
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
              <a href={link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline">
                Mở trang vận đơn
                <Glyph name="external" size={14} />
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      {justReceived && s.status === "ARRIVED" && (
        <div role="status" className="callout mt-4" data-tone={shortages.length ? "warn" : "ok"}>
          <Glyph name="checkCircle" size={18} />
          <p className="font-medium">
            Đã nhận kiện theo kết quả quét{shortages.length ? ` — ghi sự cố thiếu ${shortages.length} máy (xem bên dưới)` : " — đủ máy"}.
          </p>
          <ClearReceiveSession shipmentId={s.id} />
        </div>
      )}

      {shortages.length > 0 && (
        <section className="card mt-4 border-[color-mix(in_srgb,var(--danger)_45%,transparent)] p-4 md:p-5" aria-labelledby="su-co">
          <div className="flex items-start gap-3">
            <span className="icon-tile" data-tone="danger">
              <Glyph name="warn" size={20} />
            </span>
            <div className="min-w-0">
              <h2 id="su-co" className="font-semibold text-danger">
                Sự cố thiếu hàng · {shortages.length} máy chưa về
              </h2>
              <p className="mt-0.5 text-xs text-muted">
                Máy có trong kiện nhưng không quét được khi nhận — vẫn tính là đang vận chuyển. Tìm thấy / về sau thì nhận bổ sung; hỏi đơn vị vận chuyển kèm
                vận đơn ở phần chứng từ.
              </p>
            </div>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {shortages.map((m) => (
              <li
                key={m.itemId}
                className="flex flex-wrap items-end justify-between gap-3 rounded-2xl bg-[var(--fill)] p-3"
                aria-label={`Thiếu ${m.serial ?? m.imei1 ?? m.itemId}`}
              >
                <span className="min-w-0 text-sm">
                  <Link href={`/kho/${m.itemId}`} className="font-medium hover:underline">
                    {m.label}
                  </Link>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2">
                    <span className="chip">{m.serial ?? m.imei1 ?? "—"}</span>
                    <span className="text-xs text-muted">{ITEM_STATUS_LABEL[m.status] ?? m.status}</span>
                  </span>
                </span>
                <ActionForm action={receiveLateAction} label={`Nhận bổ sung ${m.serial ?? m.imei1 ?? m.itemId}`} className="field-row">
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="itemId" value={m.itemId} />
                  <Input label="Ngày giờ nhận" name="at" type="datetime-local" defaultValue={now} className="w-56" />
                  <TzSelect />
                  <Submit variant="secondary">Đã tìm thấy — nhận bổ sung</Submit>
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(s.status === "PLANNED" || s.status === "IN_TRANSIT" || s.status === "HOLD") && (
        <section className="card mt-4 field-row p-4 md:p-5" aria-label="Thao tác kiện">
          <h2 className="basis-full font-semibold">Cập nhật kiện</h2>
          {s.status === "PLANNED" && (
            <ActionForm action={shipAction} label="Gửi đi" className="field-row">
              <input type="hidden" name="id" value={s.id} />
              <Input
                label={`Ngày giờ gửi${rule ? ` — ${rule.departLabel}` : ""}`}
                name="at"
                type="datetime-local"
                defaultValue={shipDefault}
                className="w-56"
                hint={s.trackPickedUpAt ? "Giờ VN lúc hãng nhận hàng (bot)" : undefined}
              />
              <TzSelect />
              <Submit>Gửi đi</Submit>
            </ActionForm>
          )}
          {(s.status === "IN_TRANSIT" || s.status === "HOLD") && s.items.length > 0 && (
            <Link href={`/van-chuyen/${s.id}/nhan`} className="btn-primary self-end">
              <Glyph name="barcode" size={18} />
              Nhận bằng quét đối chiếu
            </Link>
          )}
          {(s.status === "IN_TRANSIT" || s.status === "HOLD") && (
            <ActionForm action={arriveAction} label="Đã nhận" className="field-row">
              <input type="hidden" name="id" value={s.id} />
              <Input
                label={`Ngày giờ nhận${rule ? ` — ${rule.arriveLabel}` : ""}`}
                name="at"
                type="datetime-local"
                defaultValue={arriveDefault}
                className="w-56"
                hint={s.trackDeliveredAt ? "Giờ VN lúc hãng giao (bot)" : undefined}
              />
              <TzSelect />
              <Submit variant="secondary">Đã nhận cả kiện</Submit>
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
      )}

      {s.trackingNumber && (
        <section className="card mt-5 p-4 md:p-5" aria-labelledby="bot-theo-doi" data-testid="bot-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span className="icon-tile">
                <Glyph name="bot" size={20} />
              </span>
              <div className="min-w-0">
                <h2 id="bot-theo-doi" className="font-semibold">
                  Bot theo dõi vận đơn
                </h2>
                <p className="mt-0.5 text-xs text-muted">{s.trackEnabled ? "Tự kiểm tra 07:00 và 19:00 mỗi ngày" : "Đang tắt cho kiện này"}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {s.trackEnabled && (s.status === "PLANNED" || s.status === "IN_TRANSIT" || s.status === "HOLD") && (
                <ActionForm action={checkOneAction} label="Kiểm tra ngay">
                  <input type="hidden" name="id" value={s.id} />
                  <Submit variant="secondary">Kiểm tra ngay</Submit>
                </ActionForm>
              )}
              <ActionForm action={toggleTrackAction} label={s.trackEnabled ? "Tắt bot" : "Bật bot"}>
                <input type="hidden" name="id" value={s.id} />
                <input type="hidden" name="on" value={s.trackEnabled ? "0" : "1"} />
                <Submit variant="secondary">{s.trackEnabled ? "Tắt bot cho kiện này" : "Bật bot cho kiện này"}</Submit>
              </ActionForm>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-2xl bg-[var(--fill)] px-3.5 py-3 text-sm" data-testid="bot-status">
            {track ? <TrackBadge status={track} /> : <span className="badge" data-tone="muted">Chưa kiểm tra</span>}
            {s.trackStatusText && <span className="text-muted">{s.trackStatusText}</span>}
            {s.trackCheckedAt && <span className="w-full text-xs text-muted">Kiểm tra lần cuối {vnShort(s.trackCheckedAt)} (giờ VN)</span>}
          </div>
          {s.trackError && (
            <div className="callout mt-2" data-tone="warn" role="note">
              <Glyph name="warn" size={16} />
              <p>{s.trackError}</p>
            </div>
          )}
          {track === "DELIVERED" && (s.status === "IN_TRANSIT" || s.status === "HOLD") && (
            <div className="callout mt-2" data-tone="ok" role="note">
              <Glyph name="checkCircle" size={16} />
              <p className="font-medium">
                Hãng báo đã giao{s.trackDeliveredAt ? ` lúc ${vnShort(s.trackDeliveredAt)}` : ""} — kiểm hàng rồi{" "}
                <Link href={`/van-chuyen/${s.id}/nhan`} className="underline">
                  nhận kiện bằng quét đối chiếu
                </Link>
                .
              </p>
            </div>
          )}
          {s.status === "PLANNED" && track && track !== "LABEL_CREATED" && track !== "NOT_FOUND" && (
            <div className="callout mt-2" data-tone="info" role="note">
              <Glyph name="info" size={16} />
              <p className="font-medium">
                Hãng đã nhận hàng{s.trackPickedUpAt ? ` lúc ${vnShort(s.trackPickedUpAt)}` : ""} — bấm “Gửi đi” ở trên (giờ đã điền sẵn).
              </p>
            </div>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-muted">
              <Glyph name="tag" size={15} className="mr-1.5 inline-block align-[-2px]" />
              Giờ người bán tạo nhãn {s.labelCreatedAt ? `· ${vnShort(s.labelCreatedAt)}` : "· nhập tay"}
            </summary>
            <ActionForm action={labelCreatedAction} label="Giờ tạo nhãn" className="mt-2 field-row">
              <input type="hidden" name="id" value={s.id} />
              <Input
                label="Người bán tạo nhãn lúc"
                name="at"
                type="datetime-local"
                defaultValue={s.labelCreatedAt ? isoToVnLocal(new Date(s.labelCreatedAt)) : ""}
                className="w-56"
              />
              <TzSelect />
              <Submit variant="secondary">Lưu</Submit>
              {s.labelCreatedAt && (
                <button type="submit" name="do" value="clear" className="btn-secondary">
                  Xoá
                </button>
              )}
            </ActionForm>
          </details>
        </section>
      )}

      {events.length > 0 && (
        <section className="card mt-5 p-4 md:p-5" aria-labelledby="hanh-trinh">
          <h2 id="hanh-trinh" className="font-semibold">
            Hành trình kiện <span className="text-sm font-normal text-muted">· giờ VN · {events.length} sự kiện</span>
          </h2>
          <ol className="timeline mt-3 text-sm" aria-label="Hành trình kiện">
            {events.map((e, k) => (
              <li key={k}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className={k === 0 ? "font-semibold" : ""}>{e.description}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">{vnShort(e.at)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  {e.location && (
                    <span className="inline-flex items-center gap-1">
                      <Glyph name="pin" size={13} />
                      {e.location}
                    </span>
                  )}
                  <span>{e.source === "API" ? "hãng báo" : "ghi tay"}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

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

      <section className="card mt-5 p-4" aria-label="Chứng từ kiện">
        <Attachments
          entityType="SHIPMENT"
          entityId={s.id}
          docs={docs}
          title="Chứng từ vận chuyển"
          hint={s.legType === "US_TO_VN" ? "vận đơn / AWB, chứng từ thông quan — xuất trình khi bị kiểm tra trên đường" : "phiếu gửi / giao nhận"}
        />
      </section>

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
      <HistoryLink id={id} />
    </main>
  );
}
