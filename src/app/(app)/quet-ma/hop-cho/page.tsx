import type { InboxField } from "@/domain/scan-inbox";
import { inboxTargets, listInbox, type InboxRow } from "@/server/scans/service";
import { ActionForm, Input, Select, Submit } from "../../_components/form";
import { catalogDb, Empty, NoDatabase } from "../../danh-muc/shared";
import { inboxAction, updateCaptureAction } from "../actions";
import { BackLink } from "../../_components/BackLink";

export const metadata = { title: "Hộp chờ duyệt — Quét mã" };

const FORM = "hop-cho-form";
const COLS: { key: InboxField; label: string }[] = [
  { key: "serial", label: "Serial" },
  { key: "imei1", label: "IMEI 1" },
  { key: "imei2", label: "IMEI 2" },
  { key: "partNumber", label: "Part No." },
];
/** Nguồn của từng giá trị: mã vạch / máy quét đáng tin, đọc chữ cần soát kỹ, sửa tay là người dùng đã xác nhận. */
const SRC: Record<string, string> = { BARCODE: "mã vạch", HW_SCANNER: "máy quét", OCR: "đọc chữ", PASTE: "dán", MANUAL: "sửa tay" };
const LEVEL = {
  OK: { label: "Hợp lệ", tone: "ok" },
  WARN: { label: "Cần soát", tone: "warn" },
  ERROR: { label: "Lỗi", tone: "danger" },
} as const;

export default async function InboxPage() {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-6xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const [rows, targets] = await Promise.all([listInbox(db), inboxTargets(db)]);
  const ok = rows.filter((r) => r.level !== "ERROR").length;
  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <BackLink href="/quet-ma">Quét mã</BackLink>
      <h1 className="mt-1 text-2xl font-bold">
        Hộp chờ duyệt <span className="text-base font-normal text-muted">({rows.length})</span>
      </h1>
      <p className="mt-1 text-sm text-muted">
        Quét / chụp loạt trên điện thoại rồi bấm <b>“Gửi vào hộp chờ duyệt”</b> ở trang Quét mã. Ở đây soát từng dòng (nguồn: mã vạch · đọc chữ · sửa tay), sửa
        nếu cần, rồi xác nhận vào <b>đơn mua</b> (tạo máy mới) hoặc vào <b>kiện</b> (nhận hàng).
      </p>

      {rows.length === 0 ? (
        <div className="mt-4">
          <Empty>Hộp chờ trống.</Empty>
        </div>
      ) : (
        <>
          <section className="card mt-4 p-4" aria-label="Xác nhận">
            <ActionForm action={inboxAction} id={FORM} label="Xác nhận hộp chờ" className="flex flex-col gap-4">
              <div className="field-row">
                <Select
                  label="Thêm vào đơn mua"
                  name="purchaseOrderId"
                  options={[["", "— chọn đơn mua —"], ...targets.orders.map((o) => [o.id, o.label] as const)]}
                  className="grow min-w-56"
                />
                <Input label="Đơn giá (USD) *" name="unitPrice" inputMode="decimal" placeholder="1.199" className="w-32" />
                <Select
                  label="Cấu hình (dòng chưa có Part No.)"
                  name="variantId"
                  options={[["", "— theo Part No. —"], ...targets.variants.map((v) => [v.id, v.label] as const)]}
                  className="min-w-56"
                />
                <button type="submit" name="do" value="don-mua" className="btn-primary">
                  Thêm vào đơn mua
                </button>
              </div>
              <div className="field-row">
                <Select
                  label="Nhận vào kiện (máy đã có trong hệ thống)"
                  name="shipmentId"
                  options={[["", "— chọn kiện —"], ...targets.shipments.map((s) => [s.id, s.label] as const)]}
                  className="grow min-w-56"
                />
                <button type="submit" name="do" value="kien" className="btn-secondary">
                  Nhận vào kiện
                </button>
                <button type="submit" name="do" value="bo" className="btn-danger">
                  Bỏ dòng đã chọn
                </button>
              </div>
              <p className="text-xs text-muted">
                Đã chọn sẵn {ok} dòng không lỗi. Thêm vào đơn mua: kiểm tra như lưới nhập máy (trùng Serial / IMEI toàn hệ thống, Luhn) — một dòng lỗi thì không
                tạo máy nào.
              </p>
            </ActionForm>
          </section>

          <div className="card mt-4 overflow-x-auto">
            <table className="w-full text-sm" aria-label="Dòng chờ duyệt">
              <thead className="text-left text-muted">
                <tr>
                  <th className="px-3 py-2 font-normal">
                    <span className="sr-only">Chọn</span>
                  </th>
                  <th className="px-3 py-2 font-normal">Cấu hình</th>
                  {COLS.map((c) => (
                    <th key={c.key} className="px-3 py-2 font-normal">
                      {c.label}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-normal">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.id} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

function Row({ r }: { r: InboxRow }) {
  const lv = LEVEL[r.level];
  return (
    <tr className="border-t border-border align-top" data-level={r.level} data-testid="inbox-row">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          name="ids"
          value={r.id}
          form={FORM}
          defaultChecked={r.level !== "ERROR"}
          className="size-5"
          aria-label={`Chọn ${r.fields.serial?.value ?? r.fields.imei1?.value ?? r.id}`}
        />
      </td>
      <td className="px-3 py-2">{r.variant ? r.variant.label : <span className="text-muted">?</span>}</td>
      {COLS.map((c) => {
        const f = r.fields[c.key];
        return (
          <td key={c.key} className="whitespace-nowrap px-3 py-2 font-mono text-xs">
            {f ? (
              <>
                {f.value}{" "}
                <span
                  className={`ml-1 rounded-md px-1.5 py-0.5 font-sans text-[11px] ${f.source === "OCR" ? "bg-[var(--warn-bg)] text-[var(--warn)]" : "bg-[var(--fill)] text-muted"}`}
                  title={f.source}
                >
                  {SRC[f.source] ?? ""}
                </span>
              </>
            ) : (
              <span className="text-muted">—</span>
            )}
          </td>
        );
      })}
      <td className="min-w-60 whitespace-normal px-3 py-2">
        <span className="badge" data-tone={lv.tone}>
          {lv.label}
        </span>
        {r.issues.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted">
            {r.issues.map((i, k) => (
              <li key={k} className={i.level === "ERROR" ? "text-danger" : i.level === "WARN" ? "text-[var(--warn)]" : ""}>
                {i.message}
              </li>
            ))}
          </ul>
        )}
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted">Sửa</summary>
          <ActionForm action={updateCaptureAction} label={`Sửa dòng ${r.id}`} className="mt-2 flex flex-col gap-2">
            <input type="hidden" name="id" value={r.id} />
            {COLS.map((c) => (
              <Input key={c.key} label={c.label} name={c.key} defaultValue={r.fields[c.key]?.value ?? ""} className="font-mono" autoCapitalize="characters" />
            ))}
            <Submit variant="secondary">Lưu</Submit>
          </ActionForm>
        </details>
      </td>
    </tr>
  );
}
