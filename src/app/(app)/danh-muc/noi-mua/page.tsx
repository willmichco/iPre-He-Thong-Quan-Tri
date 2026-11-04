import { SUPPLIER_KIND_LABEL, SUPPLIER_KINDS } from "@/domain/catalog";
import { listSuppliers, type SupplierRow } from "@/server/catalog/service";
import { deleteSupplierAction, saveSupplierAction } from "../actions";
import { catalogDb, Empty, NoDatabase } from "../shared";
import { ActionForm, Input, Select, Submit } from "../ui";

export const metadata = { title: "Danh mục — Nơi mua" };

const KIND_OPTIONS = SUPPLIER_KINDS.map((k) => [k, SUPPLIER_KIND_LABEL[k]] as const);

function SupplierFields({ s }: { s?: SupplierRow }) {
  return (
    <>
      <Input label="Tên nơi mua *" name="name" defaultValue={s?.name} placeholder="Apple Store, Best Buy, Costco…" className="grow min-w-56" />
      <Select label="Loại" name="kind" options={KIND_OPTIONS} defaultValue={s?.kind ?? "RETAILER"} />
      <Input
        label="Bang (Mỹ)"
        name="usState"
        defaultValue={s?.usState ?? ""}
        placeholder="OR"
        maxLength={2}
        autoCapitalize="characters"
        className="w-24"
        hint="Ảnh hưởng sales tax"
      />
      <Input
        label="Số ngày đổi trả"
        name="returnDays"
        defaultValue={s?.returnDays ?? ""}
        inputMode="numeric"
        placeholder="14"
        className="w-32"
        hint="Tự tính hạn đổi trả"
      />
      <Input label="Ghi chú" name="note" defaultValue={s?.note ?? ""} className="basis-full" />
    </>
  );
}

export default async function SuppliersPage() {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const suppliers = await listSuppliers(db);
  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4" aria-labelledby="them-noi-mua">
        <h2 id="them-noi-mua" className="font-semibold">
          Thêm nơi mua
        </h2>
        <ActionForm action={saveSupplierAction} resetOnSuccess label="Thêm nơi mua" className="mt-3 flex flex-wrap items-end gap-3">
          <SupplierFields />
          <Submit>Thêm</Submit>
        </ActionForm>
      </section>
      {suppliers.length === 0 ? (
        <Empty>Chưa có nơi mua nào.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {suppliers.map((s) => (
            <li key={s.id} className="card p-4" aria-label={s.name}>
              <div className="flex flex-wrap items-baseline gap-2">
                <b>{s.name}</b>
                <span className="text-sm text-muted">
                  {SUPPLIER_KIND_LABEL[s.kind]}
                  {s.usState ? ` · bang ${s.usState}` : ""}
                  {s.returnDays !== null ? ` · đổi trả ${s.returnDays} ngày` : ""} · {s.orderCount} đơn mua
                </span>
              </div>
              {s.note && <p className="mt-1 text-sm text-muted">{s.note}</p>}
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-muted">Sửa / xoá</summary>
                <ActionForm action={saveSupplierAction} label={`Sửa ${s.name}`} className="mt-3 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="id" value={s.id} />
                  <SupplierFields s={s} />
                  <Submit variant="secondary">Lưu</Submit>
                </ActionForm>
                <ActionForm action={deleteSupplierAction} confirm={`Xoá nơi mua ${s.name}?`} label={`Xoá ${s.name}`}>
                  <input type="hidden" name="id" value={s.id} />
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
