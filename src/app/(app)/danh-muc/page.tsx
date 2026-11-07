import Link from "next/link";
import { CATEGORIES, CATEGORY_LABEL, CODE_TYPES, type Category } from "@/domain/catalog";
import { listModels, type ModelRow, type VariantRow } from "@/server/catalog/service";
import { addCodeAction, deleteCodeAction, deleteModelAction, deleteVariantAction, saveModelAction, saveVariantAction } from "./actions";
import { catalogDb, Empty, NoDatabase } from "./shared";
import { ActionForm, Checkbox, Input, Select, Submit } from "../_components/form";

export const metadata = { title: "Danh mục — Mẫu máy & cấu hình" };

const CATEGORY_OPTIONS = CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]] as const);
const CODE_OPTIONS = CODE_TYPES.map((c) => [c, c === "PART_NUMBER" ? "Part No." : c] as const);
const weightText = (w: string | null) => (w ? `${Number(w).toLocaleString("vi-VN", { maximumFractionDigits: 3 })} kg` : "chưa có cân nặng");

export default async function ModelsPage() {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const models = await listModels(db);
  const byCategory = CATEGORIES.map((c) => [c, models.filter((m) => m.category === c)] as const).filter(([, ms]) => ms.length);

  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4" aria-labelledby="them-mau">
        <h2 id="them-mau" className="font-semibold">
          Thêm mẫu máy
        </h2>
        <ActionForm action={saveModelAction} resetOnSuccess label="Thêm mẫu máy" className="mt-3 field-row">
          <Select label="Dòng sản phẩm" name="category" options={CATEGORY_OPTIONS} />
          <Input label="Tên mẫu máy *" name="name" placeholder="vd: iPhone 17 Pro Max" className="grow min-w-56" />
          <Input label="Năm ra mắt" name="releaseYear" inputMode="numeric" placeholder="2026" className="w-28" />
          <Submit>Thêm</Submit>
        </ActionForm>
      </section>

      {byCategory.length === 0 && <Empty>Chưa có mẫu máy nào. Thêm mẫu máy đầu tiên ở trên, rồi thêm các cấu hình (dung lượng, màu) cho nó.</Empty>}

      {byCategory.map(([cat, ms]) => (
        <section key={cat} aria-labelledby={`cat-${cat}`}>
          <h2 id={`cat-${cat}`} className="text-lg font-semibold">
            {CATEGORY_LABEL[cat as Category]} <span className="text-sm font-normal text-muted">· {ms.length} mẫu</span>
          </h2>
          <div className="mt-2 flex flex-col gap-3">
            {ms.map((m) => (
              <ModelCard key={m.id} model={m} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ModelCard({ model }: { model: ModelRow }) {
  return (
    <article className="card p-4" aria-label={model.name}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">{model.name}</h3>
        {model.releaseYear && <span className="text-sm text-muted">{model.releaseYear}</span>}
        <span className="text-sm text-muted">· {model.variants.length} cấu hình</span>
      </div>

      <ul className="mt-3 flex flex-col divide-y divide-border">
        {model.variants.map((v) => (
          <VariantItem key={v.id} variant={v} modelId={model.id} />
        ))}
      </ul>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-primary">+ Thêm cấu hình</summary>
        <ActionForm action={saveVariantAction} resetOnSuccess label={`Thêm cấu hình cho ${model.name}`} className="mt-3 field-row">
          <input type="hidden" name="modelId" value={model.id} />
          <VariantFields />
          <Submit>Thêm cấu hình</Submit>
        </ActionForm>
      </details>

      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-muted">Sửa / xoá mẫu máy</summary>
        <ActionForm action={saveModelAction} label={`Sửa mẫu máy ${model.name}`} className="mt-3 field-row">
          <input type="hidden" name="id" value={model.id} />
          <Select label="Dòng sản phẩm" name="category" options={CATEGORY_OPTIONS} defaultValue={model.category} />
          <Input label="Tên mẫu máy *" name="name" defaultValue={model.name} className="grow min-w-56" />
          <Input label="Năm ra mắt" name="releaseYear" inputMode="numeric" defaultValue={model.releaseYear ?? ""} className="w-28" />
          <Submit variant="secondary">Lưu</Submit>
        </ActionForm>
        <ActionForm action={deleteModelAction} confirm={`Xoá mẫu máy ${model.name}?`} label={`Xoá mẫu máy ${model.name}`}>
          <input type="hidden" name="id" value={model.id} />
          <Submit variant="danger">Xoá mẫu máy</Submit>
        </ActionForm>
      </details>
    </article>
  );
}

function VariantFields({ v }: { v?: VariantRow }) {
  return (
    <>
      <Input label="Dung lượng" name="storage" placeholder="256GB" defaultValue={v?.storage ?? ""} className="w-28" />
      <Input label="Màu" name="color" placeholder="Silver" defaultValue={v?.color ?? ""} className="w-36" />
      <Input label="Chip (Mac)" name="chip" placeholder="M4 Pro" defaultValue={v?.chip ?? ""} className="w-28" />
      <Input label="RAM (Mac)" name="memory" placeholder="24GB" defaultValue={v?.memory ?? ""} className="w-24" />
      <Input label="Kết nối" name="connectivity" placeholder="Wi-Fi / Cellular" defaultValue={v?.connectivity ?? ""} className="w-36" />
      <Input
        label="Cân nặng mặc định (kg)"
        name="defaultWeightKg"
        inputMode="decimal"
        placeholder="0,6"
        defaultValue={v?.defaultWeightKg ? String(Number(v.defaultWeightKg)).replace(".", ",") : ""}
        hint="Dùng chia cước theo cân nặng"
        className="w-48"
      />
      <Input
        label="Mã SKU"
        name="sku"
        placeholder="tự gợi ý"
        defaultValue={v?.sku ?? ""}
        autoCapitalize="characters"
        hint={v ? undefined : "Để trống: tự tạo, vd IPPM-256-SLV"}
        className="w-44"
      />
      <Checkbox label="Đang dùng" name="isActive" defaultChecked={v ? v.isActive : true} />
    </>
  );
}

function VariantItem({ variant: v, modelId }: { variant: VariantRow; modelId: string }) {
  return (
    <li className="py-3" aria-label={v.label}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={v.isActive ? "" : "text-muted line-through"}>{v.label}</span>
        <span className="chip">{v.sku}</span>
        <span className={`text-xs ${v.defaultWeightKg ? "text-muted" : "text-[var(--warn)]"}`}>{weightText(v.defaultWeightKg)}</span>
        {v.itemCount > 0 && <span className="text-xs text-muted">· {v.itemCount} máy</span>}
        {!v.isActive && <span className="text-xs text-muted">(ngừng dùng)</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {v.codes.map((c) => (
          <ActionForm key={c.codeType + c.code} action={deleteCodeAction} confirm={`Bỏ mã ${c.code} khỏi ${v.sku}?`} label={`Bỏ mã ${c.code}`}>
            <input type="hidden" name="codeType" value={c.codeType} />
            <input type="hidden" name="code" value={c.code} />
            <span className={`chip ${c.region && c.region !== "LL/A" ? "border-[var(--warn)]" : ""}`}>
              {c.code}
              <button type="submit" aria-label={`Bỏ mã ${c.code}`} className="text-muted hover:text-danger px-1">
                ✕
              </button>
            </span>
          </ActionForm>
        ))}
        {v.codes.length === 0 && (
          <span className="text-xs text-muted">
            Chưa có mã — quét hộp sẽ chưa tự nhận ra.{" "}
            <Link href="/danh-muc/ma-may" className="underline">
              Gán mã
            </Link>
          </span>
        )}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-muted">Sửa · gán mã · xoá</summary>
        <ActionForm action={addCodeAction} resetOnSuccess label={`Gán mã cho ${v.sku}`} className="mt-3 field-row">
          <input type="hidden" name="variantId" value={v.id} />
          <Select label="Loại mã" name="codeType" options={CODE_OPTIONS} />
          <Input label="Mã trên hộp" name="code" placeholder="MDEM1LL/A" autoCapitalize="characters" autoComplete="off" spellCheck={false} className="w-44" />
          <Submit variant="secondary">Gán mã</Submit>
        </ActionForm>
        <ActionForm action={saveVariantAction} label={`Sửa cấu hình ${v.sku}`} className="mt-3 field-row">
          <input type="hidden" name="id" value={v.id} />
          <input type="hidden" name="modelId" value={modelId} />
          <VariantFields v={v} />
          <Submit variant="secondary">Lưu cấu hình</Submit>
        </ActionForm>
        <ActionForm action={deleteVariantAction} confirm={`Xoá cấu hình ${v.sku}?`} label={`Xoá cấu hình ${v.sku}`}>
          <input type="hidden" name="id" value={v.id} />
          <Submit variant="danger">Xoá cấu hình</Submit>
        </ActionForm>
      </details>
    </li>
  );
}
