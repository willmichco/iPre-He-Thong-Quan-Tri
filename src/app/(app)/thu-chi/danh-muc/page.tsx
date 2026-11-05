import { listCategories, type CategoryRow } from "@/server/ledger/service";
import { ActionForm, Checkbox, Input, Select, Submit } from "../../_components/form";
import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import { deleteCategoryAction, saveCategoryAction } from "../actions";

export const metadata = { title: "Danh mục thu chi — Thu chi" };

const DIRECTION = [
  ["OUT", "Chi"],
  ["IN", "Thu"],
] as const;

function Fields({ c }: { c?: CategoryRow }) {
  return (
    <>
      <Input label="Tên danh mục *" name="name" defaultValue={c?.name} placeholder="Phí ship COD, thuê kho…" className="grow min-w-56" />
      <Select label="Loại" name="direction" options={DIRECTION} defaultValue={c?.direction ?? "OUT"} />
      <Checkbox label="Chi phí vận hành (trừ vào lãi ròng)" name="isOperating" defaultChecked={c ? c.isOperating : true} />
    </>
  );
}

export default async function CategoriesPage() {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const cats = await listCategories(db);
  const own = cats.filter((c) => !c.isSystem);
  const system = cats.filter((c) => c.isSystem);
  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4" aria-labelledby="them-dm">
        <h2 id="them-dm" className="font-semibold">
          Thêm danh mục
        </h2>
        <p className="mt-1 text-sm text-muted">
          Danh mục cho các khoản nhập tay. Đánh dấu “vận hành” để khoản chi được trừ vào lãi ròng ở Tổng quan và Báo cáo.
        </p>
        <ActionForm action={saveCategoryAction} resetOnSuccess label="Thêm danh mục" className="field-row mt-3">
          <Fields />
          <Submit>Thêm</Submit>
        </ActionForm>
      </section>

      <section aria-labelledby="dm-rieng">
        <h2 id="dm-rieng" className="font-semibold">
          Danh mục của bạn
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {own.map((c) => (
            <li key={c.code} className="card p-4" aria-label={c.name}>
              <div className="flex flex-wrap items-baseline gap-2">
                <b>{c.name}</b>
                <span className="text-sm text-muted">
                  {c.direction === "IN" ? "Thu" : "Chi"}
                  {c.isOperating ? " · vận hành" : ""} · {c.usageCount} bút toán
                </span>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-muted">Sửa / xoá</summary>
                <ActionForm action={saveCategoryAction} label={`Sửa ${c.name}`} className="field-row mt-3">
                  <input type="hidden" name="code" value={c.code} />
                  <Fields c={c} />
                  <Submit variant="secondary">Lưu</Submit>
                </ActionForm>
                <ActionForm action={deleteCategoryAction} confirm={`Xoá danh mục ${c.name}?`} label={`Xoá ${c.name}`}>
                  <input type="hidden" name="code" value={c.code} />
                  <Submit variant="danger">Xoá</Submit>
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="dm-he-thong">
        <h2 id="dm-he-thong" className="font-semibold">
          Danh mục hệ thống
        </h2>
        <p className="mt-1 text-sm text-muted">Hệ thống tự ghi khi bạn nhập đơn mua, chi phí, đơn bán, chuyển tiền, đối soát — không sửa / xoá được.</p>
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Danh mục hệ thống">
            <tbody>
              {system.map((c) => (
                <tr key={c.code} className="border-t border-border first:border-t-0">
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-muted">{c.direction === "IN" ? "Thu" : "Chi"}</td>
                  <td className="px-3 py-2 text-muted">{c.manual ? "nhập tay được" : "tự sinh"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{c.usageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
