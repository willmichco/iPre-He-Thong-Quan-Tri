/**
 * Bot theo dõi vận đơn: 2 lần / ngày (07:00 và 19:00 giờ VN) hỏi hãng tình trạng của mọi kiện còn trên đường,
 * ghi hành trình vào kiện và báo lên trang Tổng quan. Dán link / mã vận đơn → tự nhận hãng, tạo kiện, theo dõi ngay.
 *
 * Bot không đổi trạng thái kiện / máy: "Gửi đi" / "Đã nhận" vẫn do người dùng bấm (gợi ý sẵn giờ hãng báo).
 */
import type { Sql, TransactionSql } from "postgres";
import {
  carrierOf,
  detectTracking,
  TRACK_CARRIER_LABEL,
  TRACK_CARRIERS,
  TRACK_URL_TEMPLATE,
  type TrackCarrier,
  type TrackedShipment,
  type TrackResult,
} from "@/domain/tracking";
import { createShipment, ShippingError } from "@/server/shipping/service";
import { providersFromEnv, TrackingError, type Env, type TrackingProvider } from "./providers";

type Db = Sql | TransactionSql;
type Providers = Partial<Record<TrackCarrier, TrackingProvider>>;

/** Một lần chạy dở dang trong khoảng này → lần mới bỏ qua (tránh chạy chồng khi cron + bấm tay cùng lúc). */
const RUNNING_GUARD_MIN = 10;
const MAX_PER_RUN = 200;

export interface RunSummary {
  runId: number | null;
  checked: number;
  changed: number;
  failed: number;
  /** bỏ qua vì đang có lần chạy khác */
  skipped: boolean;
  /** kiện không có nguồn dữ liệu (thiếu khoá API / không nhận ra hãng) */
  unconfigured: number;
}

const carrierFor = (provider: string | null, number: string): TrackCarrier | null =>
  provider && (TRACK_CARRIERS as readonly string[]).includes(provider) ? (provider as TrackCarrier) : carrierOf(number);

export async function runTrackingBot(
  db: Db,
  opts: { trigger: "SCHEDULE" | "MANUAL" | "ADD"; providers?: Providers; shipmentIds?: string[] } = { trigger: "SCHEDULE" },
): Promise<RunSummary> {
  const providers = opts.providers ?? providersFromEnv();
  const ids = opts.shipmentIds ?? null;
  const [run] = await db<{ id: string }[]>`
    INSERT INTO tracking_runs (trigger)
    SELECT ${opts.trigger}
     WHERE ${ids !== null}::boolean OR NOT EXISTS (
       SELECT 1 FROM tracking_runs WHERE finished_at IS NULL AND started_at > now() - make_interval(mins => ${RUNNING_GUARD_MIN}))
    RETURNING id::text`;
  if (!run) return { runId: null, checked: 0, changed: 0, failed: 0, skipped: true, unconfigured: 0 };

  const rows = await db<{ id: string; number: string; provider: string | null; track_status: string | null; eta: string | null }[]>`
    SELECT s.id::text, s.tracking_number AS number, c.tracking_provider AS provider, s.track_status, s.track_eta::text AS eta
      FROM shipments s LEFT JOIN carriers c ON c.id = s.carrier_id
     WHERE s.track_enabled AND s.tracking_number IS NOT NULL AND s.status IN ('PLANNED', 'IN_TRANSIT', 'HOLD')
       AND s.track_status IS DISTINCT FROM 'DELIVERED'
       AND (${ids}::uuid[] IS NULL OR s.id = ANY(${ids}::uuid[]))
     ORDER BY s.track_checked_at NULLS FIRST, s.id
     LIMIT ${MAX_PER_RUN}`;

  const sum: RunSummary = { runId: Number(run.id), checked: 0, changed: 0, failed: 0, skipped: false, unconfigured: 0 };
  for (const r of rows) {
    const carrier = carrierFor(r.provider, r.number);
    const provider = carrier ? providers[carrier] : undefined;
    if (!carrier || !provider) {
      sum.unconfigured++;
      await db`UPDATE shipments SET track_error = ${carrier ? `Chưa có khoá API để theo dõi ${TRACK_CARRIER_LABEL[carrier]}` : "Không nhận ra hãng của mã vận đơn — chọn đơn vị vận chuyển có hãng (UPS, USPS, FedEx, DHL)"} WHERE id = ${r.id}`;
      continue;
    }
    sum.checked++;
    try {
      const result = await provider.track(carrier, r.number);
      if (await applyResult(db, r.id, result)) sum.changed++;
    } catch (e) {
      sum.failed++;
      const msg = e instanceof TrackingError ? e.message : "Lỗi khi đọc dữ liệu hãng";
      if (!(e instanceof TrackingError)) console.error("[tracking]", e);
      await db`UPDATE shipments SET track_error = ${`${provider.name}: ${msg}`}, track_checked_at = now() WHERE id = ${r.id}`;
    }
  }
  await db`
    UPDATE tracking_runs SET finished_at = now(), checked = ${sum.checked}, changed = ${sum.changed}, failed = ${sum.failed},
           note = ${sum.unconfigured ? `${sum.unconfigured} kiện chưa có nguồn dữ liệu` : null}
     WHERE id = ${run.id}`;
  return sum;
}

/** Ghi kết quả của hãng vào kiện. Trả true nếu có gì mới (sự kiện mới / đổi trạng thái / đổi ngày hẹn giao). */
export async function applyResult(db: Db, shipmentId: string, r: TrackResult): Promise<boolean> {
  return db.begin(async (tx) => {
    const [before] = await tx<{ track_status: string | null; track_eta: string | null }[]>`
      SELECT track_status, track_eta::text FROM shipments WHERE id = ${shipmentId} FOR UPDATE`;
    if (!before) return false;
    let fresh = 0;
    for (const e of r.events) {
      if (Date.parse(e.at) <= 0) continue; // hãng không ghi giờ — bỏ
      const ins = await tx`
        INSERT INTO shipment_tracking_events (shipment_id, occurred_at, location, description, source, external_key)
        VALUES (${shipmentId}, ${e.at}, ${e.location}, ${e.description.slice(0, 500)}, 'API', ${e.key})
        ON CONFLICT (shipment_id, external_key) WHERE external_key IS NOT NULL DO NOTHING
        RETURNING 1`;
      fresh += ins.length;
    }
    const lastAt = r.events.find((e) => Date.parse(e.at) > 0)?.at ?? null;
    await tx`
      UPDATE shipments SET
             track_status = ${r.status}, track_status_text = ${r.statusText.slice(0, 300)}, track_eta = ${r.eta}, track_eta_window = ${r.etaWindow},
             track_last_event_at = COALESCE(${lastAt}::timestamptz, track_last_event_at),
             track_picked_up_at = COALESCE(${r.pickedUpAt}::timestamptz, track_picked_up_at),
             track_delivered_at = ${r.deliveredAt}::timestamptz,
             label_created_at = COALESCE(label_created_at,
                                CASE WHEN shipped_at IS NULL OR ${r.labelCreatedAt}::timestamptz <= shipped_at THEN ${r.labelCreatedAt}::timestamptz END),
             track_checked_at = now(), track_error = NULL
       WHERE id = ${shipmentId}`;
    const statusChanged = before.track_status !== r.status;
    if (statusChanged)
      await tx`
        INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
        VALUES ('UPDATE', 'shipment', ${shipmentId}, ${tx.json({ trackStatus: before.track_status })},
                ${tx.json({ trackStatus: r.status, trackStatusText: r.statusText, by: "bot" })})`;
    return fresh > 0 || statusChanged || before.track_eta !== r.eta;
  });
}

// ---- Dán link / mã vận đơn ------------------------------------------------------------------------------

export interface AddedTracking {
  id: string;
  number: string;
  carrier: TrackCarrier;
  created: boolean;
}

const DEFAULT_LEG: Record<TrackCarrier, "US_DOMESTIC" | "US_TO_VN"> = { UPS: "US_DOMESTIC", USPS: "US_DOMESTIC", FEDEX: "US_DOMESTIC", DHL: "US_TO_VN" };

/** Đơn vị vận chuyển cho hãng: dùng cái đã có trong danh mục, chưa có thì tạo. */
async function carrierRow(db: Db, code: TrackCarrier): Promise<{ id: string; leg: string }> {
  return db.begin(async (tx) => {
    const [found] = await tx<{ id: string; legs: string }[]>`
      SELECT id::text, leg_types::text AS legs FROM carriers
       WHERE tracking_provider = ${code} OR (tracking_provider IS NULL AND lower(name) = lower(${TRACK_CARRIER_LABEL[code]}))
       ORDER BY (tracking_provider = ${code}) DESC NULLS LAST, created_at LIMIT 1`;
    if (found) {
      const legs = found.legs.replace(/[{}]/g, "").split(",");
      await tx`UPDATE carriers SET tracking_provider = ${code} WHERE id = ${found.id} AND tracking_provider IS NULL`;
      return { id: found.id, leg: legs.includes(DEFAULT_LEG[code]) ? DEFAULT_LEG[code] : legs[0] };
    }
    const leg = DEFAULT_LEG[code];
    const [c] = await tx<{ id: string }[]>`
      INSERT INTO carriers (name, leg_types, tracking_url_template, tracking_provider)
      VALUES (${TRACK_CARRIER_LABEL[code]}, ${`{${leg}}`}::leg_type[], ${TRACK_URL_TEMPLATE[code]}, ${code})
      RETURNING id::text`;
    await tx`INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
             VALUES ('CREATE', 'carrier', ${c.id}, NULL, ${tx.json({ name: TRACK_CARRIER_LABEL[code], legTypes: [leg], trackingProvider: code, by: "bot" })})`;
    return { id: c.id, leg };
  });
}

/**
 * Link tra cứu / mã vận đơn → kiện được theo dõi. Mã đã có kiện → bật theo dõi lại cho kiện đó; chưa có → tạo kiện "Chờ gửi"
 * (chặng theo hãng) rồi kiểm tra ngay một lần. Không nhận ra mã nào → lỗi.
 */
export async function trackFromText(db: Db, text: string, providers?: Providers): Promise<{ added: AddedTracking[]; run: RunSummary | null }> {
  const found = detectTracking(text).slice(0, 20);
  if (!found.length)
    throw new ShippingError("INVALID_INPUT", "Không nhận ra mã vận đơn — dán link tra cứu UPS / USPS / FedEx / DHL hoặc mã vận đơn (vd 1Z…)", "link");
  const added: AddedTracking[] = [];
  for (const f of found) {
    const [existing] = await db<{ id: string }[]>`
      SELECT id::text FROM shipments WHERE tracking_number = ${f.number} AND status <> 'CANCELLED' ORDER BY created_at DESC LIMIT 1`;
    if (existing) {
      await db`UPDATE shipments SET track_enabled = true WHERE id = ${existing.id}`;
      added.push({ id: existing.id, number: f.number, carrier: f.carrier, created: false });
      continue;
    }
    const c = await carrierRow(db, f.carrier);
    const id = await createShipment(db, {
      legType: c.leg as "US_DOMESTIC",
      carrierId: c.id,
      batchId: null,
      trackingNumber: f.number,
      referenceCode: null,
      eta: null,
      chargeableWeightKg: null,
      note: "Thêm bằng link vận đơn — bot theo dõi. Quét máy vào kiện để gắn máy.",
    });
    added.push({ id, number: f.number, carrier: f.carrier, created: true });
  }
  const run = await runTrackingBot(db, { trigger: "ADD", providers, shipmentIds: added.map((a) => a.id) });
  return { added, run };
}

// ---- Đọc cho bảng điều khiển --------------------------------------------------------------------------

export interface BotRow extends TrackedShipment {
  carrierName: string | null;
  trackingNumber: string;
  trackEtaWindow: string | null;
  lastEvent: string | null;
  lastLocation: string | null;
  enabled: boolean;
}

export interface BotBoard {
  configured: TrackCarrier[];
  lastRun: { at: string; trigger: string; checked: number; changed: number; failed: number; note: string | null } | null;
  rows: BotRow[];
}

export async function trackingBoard(db: Db, env: Env = process.env): Promise<BotBoard> {
  const providers = providersFromEnv(env);
  const [runs, rows] = await Promise.all([
    db<{ at: string; trigger: string; checked: number; changed: number; failed: number; note: string | null }[]>`
      SELECT finished_at::text AS at, trigger, checked, changed, failed, note FROM tracking_runs
       WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1`,
    db<
      {
        id: string;
        number: string;
        status: string;
        carrier: string | null;
        track_status: string | null;
        track_status_text: string | null;
        track_eta: string | null;
        track_eta_window: string | null;
        eta: string | null;
        last_at: string | null;
        picked: string | null;
        delivered: string | null;
        checked: string | null;
        error: string | null;
        enabled: boolean;
        last_event: string | null;
        last_location: string | null;
      }[]
    >`
      SELECT s.id::text, s.tracking_number AS number, s.status::text, c.name AS carrier, s.track_status, s.track_status_text,
             s.track_eta::text, s.track_eta_window, s.eta::text, s.track_last_event_at::text AS last_at, s.track_picked_up_at::text AS picked,
             s.track_delivered_at::text AS delivered, s.track_checked_at::text AS checked, s.track_error AS error, s.track_enabled AS enabled,
             e.description AS last_event, e.location AS last_location
        FROM shipments s
        LEFT JOIN carriers c ON c.id = s.carrier_id
        LEFT JOIN LATERAL (SELECT description, location FROM shipment_tracking_events t WHERE t.shipment_id = s.id
                            ORDER BY occurred_at DESC LIMIT 1) e ON true
       WHERE s.tracking_number IS NOT NULL AND s.track_enabled AND s.status IN ('PLANNED', 'IN_TRANSIT', 'HOLD')
       ORDER BY (s.track_status IN ('DELIVERED', 'EXCEPTION', 'DELAYED')) DESC NULLS LAST, s.track_eta NULLS LAST, s.eta NULLS LAST, s.id`,
  ]);
  const iso = (t: string | null) => (t ? new Date(t.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toISOString() : null);
  return {
    configured: TRACK_CARRIERS.filter((c) => providers[c]),
    lastRun: runs[0] ? { ...runs[0], at: iso(runs[0].at)! } : null,
    rows: rows.map((r) => ({
      id: r.id,
      label: r.number,
      trackingNumber: r.number,
      carrierName: r.carrier,
      status: r.status,
      trackStatus: r.track_status,
      trackStatusText: r.track_status_text,
      trackEta: r.track_eta,
      trackEtaWindow: r.track_eta_window,
      eta: r.eta,
      lastEventAt: iso(r.last_at),
      pickedUpAt: iso(r.picked),
      deliveredAt: iso(r.delivered),
      checkedAt: iso(r.checked),
      error: r.error,
      enabled: r.enabled,
      lastEvent: r.last_event,
      lastLocation: r.last_location,
    })),
  };
}

export interface TrackingEventRow {
  at: string;
  location: string | null;
  description: string;
  source: "MANUAL" | "API";
}

export async function listTrackingEvents(db: Db, shipmentId: string): Promise<TrackingEventRow[]> {
  const rows = await db<{ at: string; location: string | null; description: string; source: "MANUAL" | "API" }[]>`
    SELECT to_json(occurred_at)#>>'{}' AS at, location, description, source FROM shipment_tracking_events
     WHERE shipment_id = ${shipmentId} ORDER BY occurred_at DESC, created_at DESC LIMIT 200`;
  return rows;
}

// ---- Sửa tay trên kiện ----------------------------------------------------------------------------------

export async function setTrackEnabled(db: Db, id: string, on: boolean) {
  await db.begin(async (tx) => {
    const [s] = await tx<{ on: boolean }[]>`SELECT track_enabled AS on FROM shipments WHERE id = ${id} FOR UPDATE`;
    if (!s) throw new ShippingError("NOT_FOUND", "Không tìm thấy kiện");
    await tx`UPDATE shipments SET track_enabled = ${on}, updated_at = now() WHERE id = ${id}`;
    await tx`INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
             VALUES ('UPDATE', 'shipment', ${id}, ${tx.json({ trackEnabled: s.on })}, ${tx.json({ trackEnabled: on })})`;
  });
}

/** Mốc "người bán tạo nhãn" (trước khi gửi). `at` = ISO hoặc null để xoá. */
export async function setLabelCreated(db: Db, id: string, at: string | null) {
  await db.begin(async (tx) => {
    const [s] = await tx<{ label: string | null; shipped_ms: string | null }[]>`
      SELECT label_created_at::text AS label, (extract(epoch FROM shipped_at) * 1000)::bigint::text AS shipped_ms FROM shipments WHERE id = ${id} FOR UPDATE`;
    if (!s) throw new ShippingError("NOT_FOUND", "Không tìm thấy kiện");
    if (at && s.shipped_ms && Date.parse(at) > Number(s.shipped_ms)) throw new ShippingError("INVALID_INPUT", "Giờ tạo nhãn phải trước giờ gửi đi", "at");
    await tx`UPDATE shipments SET label_created_at = ${at}, updated_at = now() WHERE id = ${id}`;
    await tx`INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
             VALUES ('UPDATE', 'shipment', ${id}, ${tx.json({ labelCreatedAt: s.label })}, ${tx.json({ labelCreatedAt: at })})`;
  });
}
