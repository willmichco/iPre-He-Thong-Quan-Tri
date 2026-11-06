/**
 * Nguồn dữ liệu vận đơn — CHỈ dùng API chính thức có khoá (không cào trang web của hãng: hãng chặn và điều khoản cấm).
 *
 *   UPS     — UPS Tracking API (developer.ups.com): UPS_CLIENT_ID + UPS_CLIENT_SECRET (OAuth client credentials)
 *   17TRACK — api.17track.net v2.2 (UPS, USPS, FedEx, DHL và nhiều forwarder): TRACK17_API_KEY
 *
 * Mỗi hãng: dùng API riêng của hãng nếu có khoá, không thì 17TRACK. Không có khoá nào → báo "chưa cấu hình".
 */
import { statusFromText, type TrackCarrier, type TrackEvent, type TrackResult, type TrackStatus } from "@/domain/tracking";

/** Biến môi trường (chỉ đọc các khoá cần dùng). */
export type Env = Record<string, string | undefined>;

export interface TrackingProvider {
  name: string;
  track(carrier: TrackCarrier, number: string): Promise<TrackResult>;
}

export class TrackingError extends Error {
  constructor(
    message: string,
    /** true = lỗi tạm (mạng, hãng quá tải) — lần sau thử lại */
    readonly transient = false,
  ) {
    super(message);
    this.name = "TrackingError";
  }
}

const TIMEOUT_MS = 15_000;

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (e) {
    throw new TrackingError(`Không kết nối được (${e instanceof Error ? e.name : "lỗi mạng"})`, true);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* thân không phải JSON */
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new TrackingError("Khoá API bị từ chối — kiểm tra lại khoá");
    if (res.status === 404) return body ?? { notFound: true };
    throw new TrackingError(`Hãng trả lỗi HTTP ${res.status}`, res.status === 429 || res.status >= 500);
  }
  return body;
}

// ---- UPS ------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** UPS "20261103" + "170500" + "-07:00" → ISO. Ưu tiên giờ GMT nếu có. */
function upsTime(a: Obj): string | null {
  const d = str(a.gmtDate) ?? str(a.date);
  const t = str(a.gmtTime) ?? str(a.time);
  if (!d || !t) return null;
  const dd = d.replace(/\D/g, "");
  const tt = t.replace(/\D/g, "").padEnd(6, "0");
  if (dd.length !== 8) return null;
  const off = str(a.gmtDate) ? "Z" : (str(a.gmtOffset) ?? "Z");
  const iso = `${dd.slice(0, 4)}-${dd.slice(4, 6)}-${dd.slice(6, 8)}T${tt.slice(0, 2)}:${tt.slice(2, 4)}:${tt.slice(4, 6)}${off}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const ymd = (v: unknown) => {
  const d = str(v)?.replace(/\D/g, "");
  return d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
};
const hm = (v: unknown) => {
  const t = str(v)?.replace(/\D/g, "");
  return t && t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : null;
};

function upsStatus(type: string | null, text: string): TrackStatus {
  const byText = statusFromText(text);
  switch (type) {
    case "D":
      return "DELIVERED";
    case "M":
    case "MV":
      return "LABEL_CREATED";
    case "X":
    case "RS":
      return byText === "DELAYED" ? "DELAYED" : "EXCEPTION";
    case "O":
      return "OUT_FOR_DELIVERY";
    case "I":
    case "P":
      return byText === "OUT_FOR_DELIVERY" || byText === "DELAYED" ? byText : "IN_TRANSIT";
    default:
      return byText ?? "UNKNOWN";
  }
}

/** Phản hồi UPS Track API v1 (`/api/track/v1/details/{số}`) → kết quả chuẩn. */
export function parseUps(body: unknown): TrackResult {
  const shipment = obj(arr(obj(obj(body).trackResponse).shipment)[0]);
  const warnings = arr(shipment.warnings)
    .map((w) => str(obj(w).message))
    .filter(Boolean);
  const pkg = obj(arr(shipment.package)[0]);
  const acts = arr(pkg.activity).map(obj);
  if (!acts.length) {
    const msg = warnings[0] ?? str(obj(arr(obj(obj(body).response).errors)[0]).message) ?? "Hãng chưa có thông tin vận đơn";
    return { status: "NOT_FOUND", statusText: msg, events: [], eta: null, etaWindow: null, labelCreatedAt: null, pickedUpAt: null, deliveredAt: null };
  }
  const events: (TrackEvent & { type: string | null; text: string })[] = acts.map((a) => {
    const st = obj(a.status);
    const addr = obj(obj(a.location).address);
    const place = [str(addr.city), str(addr.stateProvince), str(addr.countryCode)].filter(Boolean).join(", ");
    const text = str(st.description) ?? "Cập nhật";
    const at = upsTime(a) ?? new Date(0).toISOString();
    return { at, location: place || null, description: text, key: `ups:${at}:${str(st.code) ?? ""}:${text}`.slice(0, 200), type: str(st.type), text };
  });
  events.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  const cur = obj(pkg.currentStatus);
  const latest = events[0];
  const statusText = str(cur.description) ?? latest.text;
  let status = upsStatus(latest.type, latest.text);
  // trễ / sự cố báo sau một lần quét "đang đi" vẫn còn hiệu lực tới khi có quét mới
  if (status === "IN_TRANSIT" && events.slice(0, 3).some((e) => statusFromText(e.text) === "DELAYED")) status = "DELAYED";
  const dates = arr(pkg.deliveryDate).map(obj);
  const pick = (...types: string[]) => dates.find((d) => types.includes(str(d.type) ?? ""));
  const etaRow = pick("RDD") ?? pick("SDD") ?? pick("EDD") ?? (status === "DELIVERED" ? pick("DEL") : undefined) ?? dates[0];
  const win = obj(pkg.deliveryTime);
  const start = hm(win.startTime);
  const end = hm(win.endTime);
  const oldest = [...events].reverse();
  return {
    status,
    statusText,
    events: events.map(({ at, location, description, key }) => ({ at, location, description, key })),
    eta: etaRow ? ymd(etaRow.date) : null,
    etaWindow: start && end ? `${start}–${end}` : end ? `trước ${end}` : null,
    labelCreatedAt: oldest.find((e) => e.type === "M" || statusFromText(e.text) === "LABEL_CREATED")?.at ?? null,
    pickedUpAt: oldest.find((e) => e.type && e.type !== "M" && e.type !== "MV")?.at ?? null,
    deliveredAt: events.find((e) => e.type === "D")?.at ?? null,
  };
}

export function upsProvider(env: Env = process.env): TrackingProvider | null {
  const id = env.UPS_CLIENT_ID;
  const secret = env.UPS_CLIENT_SECRET;
  if (!id || !secret) return null;
  const base = env.UPS_API_BASE ?? "https://onlinetools.ups.com";
  let token: { value: string; until: number } | null = null;
  const auth = async () => {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const body = obj(
      await getJson(`${base}/security/v1/oauth/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      }),
    );
    const value = str(body.access_token);
    if (!value) throw new TrackingError("UPS không cấp mã truy cập — kiểm tra UPS_CLIENT_ID / UPS_CLIENT_SECRET");
    token = { value, until: Date.now() + Number(str(body.expires_in) ?? "3600") * 1000 };
    return value;
  };
  return {
    name: "UPS API",
    async track(_carrier, number) {
      const body = await getJson(`${base}/api/track/v1/details/${encodeURIComponent(number)}?locale=en_US&returnSignature=false`, {
        headers: { Authorization: `Bearer ${await auth()}`, transId: crypto.randomUUID().replace(/-/g, "").slice(0, 32), transactionSrc: "ipre" },
      });
      return parseUps(body);
    },
  };
}

// ---- 17TRACK --------------------------------------------------------------------------------------------

/** Mã hãng của 17TRACK. */
export const TRACK17_CARRIER: Record<TrackCarrier, number> = { UPS: 100002, USPS: 21051, FEDEX: 100003, DHL: 100001 };

const STATUS_17: Record<string, TrackStatus> = {
  NotFound: "NOT_FOUND",
  InfoReceived: "LABEL_CREATED",
  InTransit: "IN_TRANSIT",
  AvailableForPickup: "OUT_FOR_DELIVERY",
  OutForDelivery: "OUT_FOR_DELIVERY",
  DeliveryFailure: "EXCEPTION",
  Delivered: "DELIVERED",
  Exception: "EXCEPTION",
  Expired: "UNKNOWN",
};

/** Một phần tử `data.accepted[]` của 17TRACK `gettrackinfo` → kết quả chuẩn. */
export function parse17(accepted: unknown): TrackResult {
  const info = obj(obj(accepted).track_info);
  const latest = obj(info.latest_status);
  const providers = arr(obj(info.tracking).providers).map(obj);
  const raw = providers.flatMap((p) => arr(p.events).map(obj));
  const events: TrackEvent[] = raw
    .map((e) => {
      const at = str(e.time_utc) ?? str(e.time_iso);
      const ms = at ? Date.parse(at) : NaN;
      const iso = Number.isNaN(ms) ? new Date(0).toISOString() : new Date(ms).toISOString();
      const text = str(e.description) ?? "Cập nhật";
      const place = str(e.location) ?? [str(obj(e.address).city), str(obj(e.address).state)].filter(Boolean).join(", ");
      return { at: iso, location: place || null, description: text, key: `17:${iso}:${text}`.slice(0, 200), stage: str(e.stage) };
    })
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    .map(({ at, location, description, key }) => ({ at, location, description, key }));
  const code = str(latest.status) ?? "NotFound";
  const latestText = str(obj(info.latest_event).description) ?? events[0]?.description ?? code;
  let status: TrackStatus = STATUS_17[code] ?? "UNKNOWN";
  if (status === "IN_TRANSIT" && statusFromText(latestText) === "DELAYED") status = "DELAYED";
  const est = obj(obj(info.time_metrics).estimated_delivery_date);
  const etaFrom = str(est.from);
  const etaTo = str(est.to);
  const milestones = arr(info.milestone).map(obj);
  const at = (stage: string) => {
    const m = milestones.find((x) => str(x.key_stage) === stage);
    const t = m ? (str(m.time_utc) ?? str(m.time_iso)) : null;
    return t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : null;
  };
  const etaDate = (etaTo ?? etaFrom)?.slice(0, 10) ?? null;
  return {
    status,
    statusText: latestText,
    events,
    eta: etaDate && /^\d{4}-\d{2}-\d{2}$/.test(etaDate) ? etaDate : null,
    etaWindow: etaFrom && etaTo && etaFrom.slice(11, 16) && etaTo.slice(11, 16) ? `${etaFrom.slice(11, 16)}–${etaTo.slice(11, 16)}` : null,
    labelCreatedAt: at("InfoReceived"),
    pickedUpAt: at("PickedUp") ?? at("Departure"),
    deliveredAt: at("Delivered"),
  };
}

export function track17Provider(env: Env = process.env): TrackingProvider | null {
  const key = env.TRACK17_API_KEY;
  if (!key) return null;
  const base = env.TRACK17_API_BASE ?? "https://api.17track.net/track/v2.2";
  const call = (path: string, payload: unknown) =>
    getJson(`${base}/${path}`, { method: "POST", headers: { "17token": key, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return {
    name: "17TRACK",
    async track(carrier, number) {
      const item = [{ number, carrier: TRACK17_CARRIER[carrier] }];
      for (let attempt = 0; attempt < 2; attempt++) {
        const data = obj(obj(await call("gettrackinfo", item)).data);
        const ok = arr(data.accepted)[0];
        if (ok) return parse17(ok);
        const err = obj(obj(arr(data.rejected)[0]).error);
        // chưa đăng ký số này với 17TRACK → đăng ký rồi hỏi lại (17TRACK cần vài phút để có dữ liệu lần đầu)
        if (attempt === 0 && /not register|未注册/i.test(str(err.message) ?? "")) {
          await call("register", item);
          continue;
        }
        if (attempt === 1)
          return {
            status: "NOT_FOUND",
            statusText: "Đã đăng ký theo dõi với 17TRACK — dữ liệu có ở lần kiểm tra sau",
            events: [],
            eta: null,
            etaWindow: null,
            labelCreatedAt: null,
            pickedUpAt: null,
            deliveredAt: null,
          };
        throw new TrackingError(`17TRACK từ chối: ${str(err.message) ?? "không rõ lý do"}`);
      }
      throw new TrackingError("17TRACK không trả kết quả", true);
    },
  };
}

/** Chọn nguồn cho từng hãng theo khoá đang có. */
export function providersFromEnv(env: Env = process.env): Partial<Record<TrackCarrier, TrackingProvider>> {
  const ups = upsProvider(env);
  const t17 = track17Provider(env);
  return { UPS: ups ?? t17 ?? undefined, USPS: t17 ?? undefined, FEDEX: t17 ?? undefined, DHL: t17 ?? undefined };
}
