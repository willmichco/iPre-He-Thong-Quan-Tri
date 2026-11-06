import { LEG_LABEL, LEG_TYPES } from "@/domain/catalog";
import type { ShipmentInput } from "@/domain/shipping";
import { TIME_ZONES, TRACK_STATUS_LABEL, type TrackStatus } from "@/domain/tracking";
import { ActionForm, Input, Select, Submit } from "../_components/form";
import { trackLinkAction } from "./actions";

type Opt = readonly (readonly [string, string])[];

export const LEG_OPTIONS = LEG_TYPES.map((l) => [l, LEG_LABEL[l]] as const);

export function ShipmentFields({
  carriers,
  batches,
  s,
  withLeg = true,
}: {
  carriers: Opt;
  batches: Opt;
  s?: Partial<Record<keyof ShipmentInput, string | null>>;
  withLeg?: boolean;
}) {
  return (
    <>
      {withLeg && <Select label="Chặng *" name="legType" options={LEG_OPTIONS} defaultValue={s?.legType ?? "US_DOMESTIC"} />}
      <Select label="Đơn vị vận chuyển" name="carrierId" options={carriers} defaultValue={s?.carrierId ?? ""} className="min-w-44" />
      <Input label="Mã vận đơn (tracking)" name="trackingNumber" defaultValue={s?.trackingNumber ?? ""} autoCapitalize="characters" className="w-52" />
      <Input label="Mã bill / AWB" name="referenceCode" defaultValue={s?.referenceCode ?? ""} className="w-40" />
      <Select label="Thuộc chuyến" name="batchId" options={batches} defaultValue={s?.batchId ?? ""} className="min-w-40" />
      <Input label="Ngày dự kiến nhận" name="eta" type="date" defaultValue={s?.eta ?? ""} className="w-44" hint="Trống: tự tính khi gửi" />
      <Input label="Cân tính cước (kg)" name="chargeableWeightKg" inputMode="decimal" defaultValue={s?.chargeableWeightKg ?? ""} className="w-36" />
      <Input label="Ghi chú" name="note" defaultValue={s?.note ?? ""} className="basis-full" />
    </>
  );
}

export const vnd = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
export const dmy = (d: string | null) => (d ? d.slice(0, 10).split("-").reverse().join("/") : "—");
export const todayVn = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

/** Ô múi giờ đi kèm ô ngày giờ: mốc ở Mỹ nhập theo giờ địa phương in trên trang hãng, hệ thống tự đổi sang giờ VN. */
export function TzSelect({ defaultValue = "Asia/Ho_Chi_Minh" }: { defaultValue?: string }) {
  return <Select label="Theo giờ" name="tz" options={TIME_ZONES} defaultValue={defaultValue} className="w-60" />;
}

/** Dán link tra cứu (UPS, USPS, FedEx, DHL) hoặc mã vận đơn → bot nhận hãng, tạo kiện và theo dõi 2 lần / ngày. */
export function TrackLinkForm({ compact = false }: { compact?: boolean }) {
  return (
    <ActionForm action={trackLinkAction} resetOnSuccess label="Theo dõi vận đơn" className="field-row">
      <Input
        label="Link tra cứu hoặc mã vận đơn"
        name="link"
        placeholder="https://www.ups.com/track?…trackNums=1Z…  hoặc  1Z…"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        className={compact ? "grow basis-64" : "grow basis-80"}
        hint={compact ? undefined : "Dán nhiều mã cách nhau bởi dấu phẩy / xuống dòng cũng được. Mã đã có kiện → bật theo dõi cho kiện đó."}
      />
      <Submit>Theo dõi</Submit>
    </ActionForm>
  );
}

type Tone = "ok" | "danger" | "warn" | "info" | "muted";
const TRACK_TONE: Record<TrackStatus, Tone> = {
  LABEL_CREATED: "muted",
  IN_TRANSIT: "info",
  DELAYED: "danger",
  OUT_FOR_DELIVERY: "info",
  DELIVERED: "ok",
  EXCEPTION: "danger",
  NOT_FOUND: "muted",
  UNKNOWN: "muted",
};

/** Trạng thái hãng báo (bot) dạng huy hiệu màu; chưa có trạng thái → "Chưa đọc được" (có lỗi) / "Chờ lần kiểm tra đầu". */
export function TrackBadge({ status, error, testid }: { status: string | null; error?: string | null; testid?: string }) {
  const st = status as TrackStatus | null;
  const label = st ? (TRACK_STATUS_LABEL[st] ?? st) : error ? "Chưa đọc được" : "Chờ lần kiểm tra đầu";
  const tone: Tone = st ? (TRACK_TONE[st] ?? "muted") : error ? "warn" : "muted";
  const moving = st === "IN_TRANSIT" || st === "OUT_FOR_DELIVERY";
  return (
    <span className="badge" data-tone={tone} data-live={moving ? "" : undefined} data-testid={testid}>
      {label}
    </span>
  );
}
