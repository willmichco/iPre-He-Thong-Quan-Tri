import { Input, Textarea } from "../../_components/form";

export type CustomerFormValues = {
  fullName?: string;
  phone?: string | null;
  zalo?: string | null;
  facebook?: string | null;
  address?: string | null;
  note?: string | null;
};

export function CustomerFields({ c }: { c?: CustomerFormValues }) {
  return (
    <>
      <Input label="Tên khách *" name="fullName" defaultValue={c?.fullName} className="grow min-w-48" autoComplete="off" />
      <Input label="Số điện thoại" name="phone" type="tel" inputMode="tel" defaultValue={c?.phone ?? ""} placeholder="0901 234 567" className="w-44" />
      <Input label="Zalo" name="zalo" defaultValue={c?.zalo ?? ""} className="w-40" />
      <Input label="Facebook" name="facebook" defaultValue={c?.facebook ?? ""} className="min-w-48" />
      <Input label="Địa chỉ giao hàng" name="address" defaultValue={c?.address ?? ""} className="basis-full" />
      <Textarea label="Ghi chú" name="note" defaultValue={c?.note ?? ""} rows={2} className="basis-full" />
    </>
  );
}
