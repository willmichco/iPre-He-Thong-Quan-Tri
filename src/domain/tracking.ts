/**
 * Bot theo dõi vận đơn — phần thuần.
 *
 *  - Nhận biết hãng + mã vận đơn từ link tra cứu (UPS, USPS, FedEx, DHL) hoặc từ mã dán thẳng.
 *  - Trạng thái chuẩn hoá từ dữ liệu hãng trả về; cảnh báo cho bảng "Cần xử lý".
 *  - Đổi ngày giờ địa phương (múi giờ Mỹ…) → thời điểm chuẩn để ghi mốc.
 *
 * Bot CHỈ đọc và báo — không tự bấm "Gửi đi" / "Đã nhận": mốc của máy vẫn do người dùng xác nhận trên kiện
 * (nhận kiện còn phải quét đối chiếu từng máy).
 */

export const TRACK_CARRIERS = ["UPS", "USPS", "FEDEX", "DHL"] as const;
export type TrackCarrier = (typeof TRACK_CARRIERS)[number];

export const TRACK_CARRIER_LABEL: Record<TrackCarrier, string> = { UPS: "UPS", USPS: "USPS", FEDEX: "FedEx", DHL: "DHL Express" };

/** Link tra cứu công khai của hãng (mẫu cho danh mục đơn vị vận chuyển). */
export const TRACK_URL_TEMPLATE: Record<TrackCarrier, string> = {
  UPS: "https://www.ups.com/track?tracknum={tracking}",
  USPS: "https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking}",
  FEDEX: "https://www.fedex.com/fedextrack/?trknbr={tracking}",
  DHL: "https://www.dhl.com/us-en/home/tracking.html?tracking-id={tracking}",
};

export interface DetectedTracking {
  carrier: TrackCarrier;
  number: string;
}

/** Số kiểm tra của mã UPS 1Z (ký tự cuối) — loại mã gõ / dán nhầm. */
export function upsCheckDigitOk(n: string): boolean {
  if (!/^1Z[0-9A-Z]{16}$/.test(n)) return false;
  let sum = 0;
  [...n.slice(2, 17)].forEach((c, i) => {
    const v = /\d/.test(c) ? Number(c) : (c.charCodeAt(0) - 63) % 10;
    sum += i % 2 === 1 ? v * 2 : v;
  });
  return (10 - (sum % 10)) % 10 === Number(n[17]);
}

/** Mã vận đơn (đã bỏ khoảng trắng, viết hoa) → hãng; không đoán được → null. */
export function carrierOf(number: string): TrackCarrier | null {
  const n = number.replace(/[\s-]+/g, "").toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return upsCheckDigitOk(n) ? "UPS" : null;
  if (/^(9[1-5]\d{18,20}|82\d{8}|[A-Z]{2}\d{9}US)$/.test(n)) return "USPS";
  if (/^(\d{12}|\d{15}|96\d{20})$/.test(n)) return "FEDEX";
  if (/^\d{10}$/.test(n) || /^JJD\d{18}$/.test(n)) return "DHL";
  return null;
}

const HOST_CARRIER: [RegExp, TrackCarrier][] = [
  [/(^|\.)ups\.com$/, "UPS"],
  [/(^|\.)usps\.com$/, "USPS"],
  [/(^|\.)fedex\.com$/, "FEDEX"],
  [/(^|\.)dhl\.(com|de)$/, "DHL"],
];
/** Tham số chứa mã vận đơn trong link tra cứu của từng hãng (không phân biệt hoa thường). */
const NUMBER_PARAMS = ["tracknums", "tracknum", "inquirynumber1", "tlabels", "qtc_tlabels1", "trknbr", "tracknumbers", "tracking-id", "awb", "id"];

/**
 * Văn bản dán vào (link tra cứu, nhiều link, hoặc mã vận đơn cách nhau bởi dấu phẩy / xuống dòng) → các vận đơn nhận ra được.
 * Link của hãng → tin hãng theo tên miền; mã trơn → đoán theo dạng mã (UPS có kiểm tra số cuối).
 */
export function detectTracking(text: string): DetectedTracking[] {
  const out: DetectedTracking[] = [];
  const push = (carrier: TrackCarrier | null, raw: string) => {
    const number = raw.replace(/[\s-]+/g, "").toUpperCase();
    if (!carrier || !/^[0-9A-Z]{8,34}$/.test(number)) return;
    if (carrier === "UPS" && number.startsWith("1Z") && !upsCheckDigitOk(number)) return;
    if (!out.some((o) => o.number === number)) out.push({ carrier, number });
  };
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    if (/^https?:\/\//i.test(token)) {
      let url: URL;
      try {
        url = new URL(token);
      } catch {
        continue;
      }
      const host = url.hostname.toLowerCase();
      const carrier = HOST_CARRIER.find(([re]) => re.test(host))?.[1] ?? null;
      const params = new Map([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
      const value = NUMBER_PARAMS.map((p) => params.get(p)).find(Boolean);
      // FedEx kiểu mới: /fedextrack/?trknbr=… ; UPS cũ: /track/…/1Z… trong đường dẫn
      const fromPath = url.pathname.split("/").find((seg) => carrierOf(seg) !== null);
      for (const n of (value ?? fromPath ?? "").split(/[,;\s]+/).filter(Boolean)) push(carrier ?? carrierOf(n), n);
    } else push(carrierOf(token), token);
  }
  return out;
}

// ---- Trạng thái chuẩn hoá ---------------------------------------------------------------------------------

export const TRACK_STATUSES = ["LABEL_CREATED", "IN_TRANSIT", "DELAYED", "OUT_FOR_DELIVERY", "DELIVERED", "EXCEPTION", "NOT_FOUND", "UNKNOWN"] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

export const TRACK_STATUS_LABEL: Record<TrackStatus, string> = {
  LABEL_CREATED: "Mới tạo nhãn — người bán chưa gửi",
  IN_TRANSIT: "Đang vận chuyển",
  DELAYED: "Bị trễ",
  OUT_FOR_DELIVERY: "Đang đi giao",
  DELIVERED: "Hãng báo đã giao",
  EXCEPTION: "Sự cố",
  NOT_FOUND: "Hãng chưa có thông tin",
  UNKNOWN: "Không rõ",
};

export interface TrackEvent {
  /** ISO, có múi giờ */
  at: string;
  location: string | null;
  description: string;
  /** khoá chống trùng (cùng một sự kiện của hãng qua nhiều lần kiểm tra) */
  key: string;
}

export interface TrackResult {
  status: TrackStatus;
  statusText: string;
  /** mới → cũ */
  events: TrackEvent[];
  /** ngày giao dự kiến của hãng (YYYY-MM-DD, theo nơi nhận) */
  eta: string | null;
  /** khung giờ giao, vd "10:00–14:00" */
  etaWindow: string | null;
  labelCreatedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
}

/** Mô tả sự kiện bằng tiếng Anh của hãng → trạng thái (khi hãng không trả mã rõ ràng). */
export function statusFromText(text: string): TrackStatus | null {
  const t = text.toLowerCase();
  if (/\bdelivered\b/.test(t) && !/will be delivered|to be delivered|not delivered|undeliverable/.test(t)) return "DELIVERED";
  if (/out for delivery/.test(t)) return "OUT_FOR_DELIVERY";
  if (/delay|rescheduled|will be late|running late/.test(t)) return "DELAYED";
  if (/exception|damaged|returned to sender|return to sender|refused|unable to deliver|held|lost/.test(t)) return "EXCEPTION";
  if (/label created|shipper created a label|billing information received|shipment information received|pre-shipment|order processed/.test(t))
    return "LABEL_CREATED";
  return null;
}

// ---- Ngày giờ theo múi giờ ----------------------------------------------------------------------------

/** Múi giờ hay dùng khi ghi mốc (giờ địa phương nơi xảy ra sự kiện). */
export const TIME_ZONES = [
  ["Asia/Ho_Chi_Minh", "Giờ Việt Nam"],
  ["America/Phoenix", "Arizona (MST, không đổi giờ)"],
  ["America/Los_Angeles", "Thái Bình Dương — OR, CA, WA"],
  ["America/Denver", "Miền núi — UT, CO"],
  ["America/Chicago", "Miền Trung — TX, IL"],
  ["America/New_York", "Miền Đông — NY, FL"],
] as const;
export type TimeZone = (typeof TIME_ZONES)[number][0];
export const isTimeZone = (tz: string): tz is TimeZone => TIME_ZONES.some(([z]) => z === tz);

/** Độ lệch (phút) của múi giờ so với UTC tại thời điểm `ms`. */
function offsetMinutes(tz: string, ms: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/**
 * "2026-11-03T17:05" theo giờ địa phương của `tz` → ISO UTC. Tính cả giờ mùa hè (DST) của Mỹ.
 * Giờ không tồn tại (lúc chuyển sang giờ mùa hè) → lấy theo độ lệch trước khi chuyển.
 */
export function zonedLocalToIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(local.trim());
  if (!m || !isTimeZone(tz)) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(guess) || new Date(guess).getUTCDate() !== Number(m[3])) return null;
  let ms = guess - offsetMinutes(tz, guess) * 60_000;
  ms = guess - offsetMinutes(tz, ms) * 60_000;
  return new Date(ms).toISOString();
}

/** Thời điểm → "dd/mm hh:mi" giờ VN. */
export function vnShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const vn = new Date(d.getTime() + 7 * 3600_000).toISOString();
  return `${vn.slice(8, 10)}/${vn.slice(5, 7)} ${vn.slice(11, 16)}`;
}

/** Khoảng cách giữa hai thời điểm → "19 giờ 09 phút" / "2 ngày 5 giờ". */
export function humanDuration(fromIso: string, toIso: string): string | null {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const mi = min % 60;
  if (d > 0) return `${d} ngày${h ? ` ${h} giờ` : ""}`;
  if (h > 0) return `${h} giờ ${String(mi).padStart(2, "0")} phút`;
  return `${mi} phút`;
}

// ---- Lịch chạy bot ---------------------------------------------------------------------------------------

/** Bot chạy 2 lần / ngày: 07:00 và 19:00 giờ VN (= 00:00 và 12:00 UTC). */
export const BOT_HOURS_VN = [7, 19] as const;
export const BOT_CRON_UTC = "0 0,12 * * *";

/** Lần chạy kế tiếp theo lịch (ISO) tính từ `now`. */
export function nextBotRun(now: Date): string {
  const vnNow = now.getTime() + 7 * 3600_000;
  const day = Math.floor(vnNow / 86_400_000) * 86_400_000;
  for (const add of [0, 1])
    for (const h of BOT_HOURS_VN) {
      const t = day + add * 86_400_000 + h * 3600_000;
      if (t > vnNow) return new Date(t - 7 * 3600_000).toISOString();
    }
  return new Date(day + 86_400_000 + BOT_HOURS_VN[0] * 3600_000 - 7 * 3600_000).toISOString();
}

// ---- Cảnh báo -------------------------------------------------------------------------------------------

export interface TrackedShipment {
  id: string;
  label: string;
  /** trạng thái kiện trong hệ thống */
  status: string;
  trackStatus: string | null;
  trackStatusText: string | null;
  trackEta: string | null;
  eta: string | null;
  lastEventAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  checkedAt: string | null;
  error: string | null;
}

export interface TrackAlert {
  kind: "TRACK_DELIVERED" | "TRACK_PICKED_UP" | "TRACK_PROBLEM" | "TRACK_STALE" | "TRACK_ETA_CHANGED" | "TRACK_ERROR";
  level: "critical" | "warning" | "info";
  title: string;
  detail?: string;
  href: string;
}

const STALE_HOURS = 72;
const dmyShort = (d: string) => d.split("-").reverse().join("/");

/** Kết quả bot → việc cần làm. Bot không tự ghi mốc nên mọi gợi ý đều dẫn về trang kiện để người dùng xác nhận. */
export function trackingAlerts(rows: readonly TrackedShipment[], now: Date): TrackAlert[] {
  const out: TrackAlert[] = [];
  const unread = rows.filter((s) => s.error && !s.trackStatus);
  if (unread.length)
    out.push({
      kind: "TRACK_ERROR",
      level: "info",
      title: unread.length === 1 ? `Bot chưa đọc được vận đơn ${unread[0].label}` : `Bot chưa đọc được ${unread.length} vận đơn`,
      detail: [...new Set(unread.map((s) => s.error))].slice(0, 2).join(" · "),
      href: unread.length === 1 ? `/van-chuyen/${unread[0].id}` : "/van-chuyen",
    });
  for (const s of rows) {
    const href = `/van-chuyen/${s.id}`;
    const open = s.status === "IN_TRANSIT" || s.status === "HOLD";
    if (s.error && !s.trackStatus) continue;
    if (s.trackStatus === "DELIVERED" && (open || s.status === "PLANNED")) {
      out.push({
        kind: "TRACK_DELIVERED",
        level: "warning",
        title: `Kiện ${s.label}: hãng báo đã giao${s.deliveredAt ? ` lúc ${vnShort(s.deliveredAt)} (giờ VN)` : ""}`,
        detail: "Kiểm hàng rồi bấm nhận kiện (quét đối chiếu) để ghi mốc cho từng máy",
        href,
      });
      continue;
    }
    if (s.status === "PLANNED" && s.trackStatus && s.trackStatus !== "LABEL_CREATED" && s.trackStatus !== "NOT_FOUND") {
      out.push({
        kind: "TRACK_PICKED_UP",
        level: "info",
        title: `Kiện ${s.label}: hãng đã nhận hàng${s.pickedUpAt ? ` lúc ${vnShort(s.pickedUpAt)} (giờ VN)` : ""} — bấm "Gửi đi"`,
        href,
      });
    }
    if (s.trackStatus === "DELAYED" || s.trackStatus === "EXCEPTION") {
      out.push({
        kind: "TRACK_PROBLEM",
        level: s.trackStatus === "EXCEPTION" ? "critical" : "warning",
        title: `Kiện ${s.label}: ${s.trackStatus === "DELAYED" ? "hãng báo trễ" : "hãng báo sự cố"}`,
        detail: [s.trackStatusText, s.trackEta ? `giao dự kiến ${dmyShort(s.trackEta)}` : null].filter(Boolean).join(" · ") || undefined,
        href,
      });
    } else if (open && s.trackEta && s.eta && s.trackEta > s.eta) {
      out.push({
        kind: "TRACK_ETA_CHANGED",
        level: "info",
        title: `Kiện ${s.label}: hãng hẹn giao ${dmyShort(s.trackEta)}, muộn hơn dự kiến ${dmyShort(s.eta)}`,
        href,
      });
    }
    if (open && s.lastEventAt && s.trackStatus !== "DELIVERED") {
      const hours = (now.getTime() - Date.parse(s.lastEventAt)) / 3600_000;
      if (hours > STALE_HOURS)
        out.push({
          kind: "TRACK_STALE",
          level: "info",
          title: `Kiện ${s.label}: ${Math.floor(hours / 24)} ngày không có cập nhật mới từ hãng`,
          detail: s.trackStatusText ?? undefined,
          href,
        });
    }
  }
  return out;
}
