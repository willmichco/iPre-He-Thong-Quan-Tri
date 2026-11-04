import { LEG_LABEL, LEG_TYPES } from "@/domain/catalog";
import type { ShipmentInput } from "@/domain/shipping";
import { Input, Select } from "../_components/form";

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
