import { checkVariantCode, classifyCodeType, CODE_TYPES } from "@/domain/catalog";
import { listModels, lookupCodes } from "@/server/catalog/service";
import { addCodeAction, deleteCodeAction } from "../actions";
import { catalogDb, Empty, NoDatabase } from "../shared";
import { ActionForm, Input, Select, Submit } from "../ui";

export const metadata = { title: "Danh mục — Mã Part No. / UPC" };

const CODE_OPTIONS = CODE_TYPES.map((c) => [c, c === "PART_NUMBER" ? "Part No." : c] as const);

export default async function CodesPage({ searchParams }: PageProps<"/danh-muc/ma-may">) {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const raw = (await searchParams).code;
  const query = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const models = await listModels(db);
  const variants = models.flatMap((m) => m.variants);
  const codes = variants.flatMap((v) => v.codes.map((c) => ({ ...c, variant: v })));

  const type = query ? classifyCodeType(query) : null;
  const checked = query && type ? checkVariantCode(type, query) : null;
  const found = checked?.ok ? (await lookupCodes(db, [checked.code]))[0] : undefined;
  const variantOptions = [["", "— chọn cấu hình —"] as const, ...variants.filter((v) => v.isActive).map((v) => [v.id, `${v.label} (${v.sku})`] as const)];

  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4" aria-labelledby="tra-ma">
        <h2 id="tra-ma" className="font-semibold">
          Tra mã trên hộp
        </h2>
        <p className="mt-1 text-sm text-muted">
          Mỗi Part No. (vd: <code>MDEM1LL/A</code>) hoặc UPC chỉ cần gán <b>một lần</b>: lần sau quét hộp là tự điền cấu hình, cân nặng.
        </p>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3" role="search">
          <label className="flex flex-col gap-1 text-sm grow min-w-56">
            <span className="text-muted">Part No. / UPC / EAN</span>
            <input
              name="code"
              defaultValue={query}
              className="field"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="MDEM1LL/A"
            />
          </label>
          <button type="submit" className="btn-secondary">
            Tra
          </button>
        </form>

        {query && !type && (
          <p role="alert" className="mt-3 text-sm text-danger">
            &quot;{query}&quot; không phải Part No. của Apple, UPC (12 số) hay EAN (13 số).
          </p>
        )}
        {checked && !checked.ok && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {checked.error}
          </p>
        )}
        {found && (
          <p role="status" className="mt-3 text-sm">
            ✓ <span className="chip">{found.code}</span> là <b>{found.label}</b> ({found.sku})
            {found.region && found.region !== "LL/A" && <span className="ml-1 text-[var(--warn)]">· ⚠ thị trường {found.region}, không phải hàng Mỹ LL/A</span>}
          </p>
        )}
        {checked?.ok && !found && (
          <div className="mt-3">
            <p className="text-sm">
              Mã <span className="chip">{checked.code}</span> chưa có trong danh mục
              {checked.region && checked.region !== "LL/A" && <span className="ml-1 text-[var(--warn)]">· ⚠ thị trường {checked.region}</span>}. Đây là cấu hình
              nào?
            </p>
            {variants.length === 0 ? (
              <Empty>Chưa có cấu hình nào — thêm mẫu máy và cấu hình ở tab &quot;Mẫu máy &amp; cấu hình&quot; trước.</Empty>
            ) : (
              <ActionForm action={addCodeAction} label="Gán mã cho cấu hình" className="mt-2 flex flex-wrap items-end gap-3">
                <input type="hidden" name="codeType" value={type!} />
                <input type="hidden" name="code" value={checked.code} />
                <Select label="Cấu hình" name="variantId" options={variantOptions} className="grow min-w-64" />
                <Submit>Gán mã</Submit>
              </ActionForm>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="ds-ma">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ds-ma" className="text-lg font-semibold">
            Mã đã gán <span className="text-sm font-normal text-muted">· {codes.length}</span>
          </h2>
        </div>
        {codes.length === 0 ? (
          <Empty>Chưa gán mã nào.</Empty>
        ) : (
          <div className="card mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="p-3 font-medium">Mã</th>
                  <th className="p-3 font-medium">Loại</th>
                  <th className="p-3 font-medium">Thị trường</th>
                  <th className="p-3 font-medium">Cấu hình</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.codeType + c.code} className="border-t border-border">
                    <td className="p-3 font-mono">{c.code}</td>
                    <td className="p-3">{c.codeType === "PART_NUMBER" ? "Part No." : c.codeType}</td>
                    <td className={`p-3 ${c.region && c.region !== "LL/A" ? "text-[var(--warn)]" : ""}`}>{c.region ?? "—"}</td>
                    <td className="p-3">
                      {c.variant.label} <span className="chip">{c.variant.sku}</span>
                    </td>
                    <td className="p-3 text-right">
                      <ActionForm action={deleteCodeAction} confirm={`Bỏ mã ${c.code}?`} label={`Bỏ mã ${c.code}`}>
                        <input type="hidden" name="codeType" value={c.codeType} />
                        <input type="hidden" name="code" value={c.code} />
                        <Submit variant="danger">Bỏ</Submit>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-primary">+ Gán mã thủ công</summary>
          <ActionForm action={addCodeAction} resetOnSuccess label="Gán mã thủ công" className="mt-3 flex flex-wrap items-end gap-3">
            <Select label="Loại mã" name="codeType" options={CODE_OPTIONS} />
            <Input label="Mã" name="code" autoCapitalize="characters" autoComplete="off" spellCheck={false} className="w-44" />
            <Select label="Cấu hình" name="variantId" options={variantOptions} className="grow min-w-64" />
            <Submit>Gán mã</Submit>
          </ActionForm>
        </details>
      </section>
    </div>
  );
}
