import { LEG_LABEL, LEG_TYPES } from "@/domain/catalog";
import { listCarriers, type CarrierRow } from "@/server/catalog/service";
import { deleteCarrierAction, saveCarrierAction } from "../actions";
import { catalogDb, Empty, NoDatabase } from "../shared";
import { ActionForm, CheckboxGroup, Input, Submit } from "../ui";

export const metadata = { title: "Danh mục — Đơn vị vận chuyển" };

const LEG_OPTIONS = LEG_TYPES.map((l) => [l, LEG_LABEL[l]] as const);

function CarrierFields({ c }: { c?: CarrierRow }) {
  return (
    <>
      <Input label="Tên đơn vị *" name="name" defaultValue={c?.name} placeholder="USPS, forwarder, chành xe…" className="grow min-w-56" />
      <Input
        label="Thời gian giao (ngày)"
        name="defaultLeadDays"
        defaultValue={c?.defaultLeadDays ?? ""}
        inputMode="numeric"
        className="w-40"
        hint="Tự tính ETA khi gửi"
      />
      <Input label="Liên hệ" name="contact" defaultValue={c?.contact ?? ""} className="w-56" />
      <CheckboxGroup label="Phục vụ chặng *" name="legTypes" options={LEG_OPTIONS} defaults={c?.legTypes} />
      <Input
        label="Mẫu link tra cứu vận đơn"
        name="trackingUrlTemplate"
        defaultValue={c?.trackingUrlTemplate ?? ""}
        placeholder="https://…/track?no={tracking}"
        inputMode="url"
        className="basis-full"
        hint="{tracking} được thay bằng mã vận đơn của kiện"
      />
      <Input label="Ghi chú" name="note" defaultValue={c?.note ?? ""} className="basis-full" />
    </>
  );
}

export default async function CarriersPage() {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const carriers = await listCarriers(db);
  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4" aria-labelledby="them-dvvc">
        <h2 id="them-dvvc" className="font-semibold">
          Thêm đơn vị vận chuyển
        </h2>
        <ActionForm action={saveCarrierAction} resetOnSuccess label="Thêm đơn vị vận chuyển" className="mt-3 flex flex-wrap items-end gap-3">
          <CarrierFields />
          <Submit>Thêm</Submit>
        </ActionForm>
      </section>
      {carriers.length === 0 ? (
        <Empty>Chưa có đơn vị vận chuyển nào.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {carriers.map((c) => (
            <li key={c.id} className="card p-4" aria-label={c.name}>
              <div className="flex flex-wrap items-baseline gap-2">
                <b>{c.name}</b>
                <span className="text-sm text-muted">
                  {c.legTypes.map((l) => LEG_LABEL[l]).join(" · ")}
                  {c.defaultLeadDays !== null ? ` · ~${c.defaultLeadDays} ngày` : ""} · {c.shipmentCount} kiện
                </span>
              </div>
              {c.contact && <p className="mt-1 text-sm text-muted">{c.contact}</p>}
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-muted">Sửa / xoá</summary>
                <ActionForm action={saveCarrierAction} label={`Sửa ${c.name}`} className="mt-3 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="id" value={c.id} />
                  <CarrierFields c={c} />
                  <Submit variant="secondary">Lưu</Submit>
                </ActionForm>
                <ActionForm action={deleteCarrierAction} confirm={`Xoá ${c.name}?`} label={`Xoá ${c.name}`}>
                  <input type="hidden" name="id" value={c.id} />
                  <Submit variant="danger">Xoá</Submit>
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
