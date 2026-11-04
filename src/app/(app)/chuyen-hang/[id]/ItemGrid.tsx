"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ClipboardEvent, type KeyboardEvent } from "react";
import { parseDecimalInput } from "@/domain/catalog";
import { classifyCode } from "@/domain/identifiers";
import {
  CONDITION_LABEL,
  CONDITIONS,
  emptyRow,
  isBlankRow,
  ITEM_STATUS_LABEL,
  matchVariant,
  parsePastedGrid,
  sumPrices,
  validateGrid,
  type GridField,
  type GridRow,
  type RowIssue,
  type VariantRef,
} from "@/domain/purchasing";
import { saveItemsAction } from "../actions";

/** Thông tin chỉ-đọc của máy đã lưu (trạng thái, giá vốn). */
export interface SavedInfo {
  status: string;
  landedCostVnd: string;
  hasEstimate: boolean;
  locked: boolean;
}

interface Row extends GridRow {
  key: number;
  /** chữ người dùng gõ ở ô cấu hình (gõ tắt) */
  variantText: string;
}

const COLS: { field: GridField; label: string; width: string; mono?: boolean; inputMode?: "decimal" | "numeric" }[] = [
  { field: "variantId", label: "Cấu hình * (gõ tắt)", width: "min-w-56" },
  { field: "unitPrice", label: "Đơn giá *", width: "w-28", inputMode: "decimal" },
  { field: "serial", label: "Serial", width: "w-36", mono: true },
  { field: "imei1", label: "IMEI 1", width: "w-44", mono: true, inputMode: "numeric" },
  { field: "imei2", label: "IMEI 2", width: "w-44", mono: true, inputMode: "numeric" },
  { field: "partNumber", label: "Part No.", width: "w-32", mono: true },
  { field: "condition", label: "Tình trạng", width: "w-32" },
  { field: "weightKg", label: "Kg", width: "w-20", inputMode: "decimal" },
  { field: "note", label: "Ghi chú", width: "min-w-40" },
];
const CODE_FIELDS: GridField[] = ["serial", "imei1", "imei2", "partNumber"];

let seq = 0;
const withKey = (r: GridRow, variants: readonly VariantRef[]): Row => ({
  ...r,
  key: ++seq,
  variantText: variants.find((v) => v.id === r.variantId)?.label ?? "",
});
const ensureTrailingBlank = (rows: Row[], variants: readonly VariantRef[]) =>
  rows.length && isBlankRow(rows[rows.length - 1]) ? rows : [...rows, withKey(emptyRow(), variants)];

const usd = (s: string) => Number(s).toLocaleString("en-US", { style: "currency", currency: "USD" });
const vnd = (n: bigint | string) =>
  BigInt(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export function ItemGrid({
  purchaseOrderId,
  version,
  initialRows,
  saved,
  variants,
  subtotal,
  fxRate,
  currency,
}: {
  purchaseOrderId: string;
  /** đổi khi dữ liệu máy đã lưu đổi (sau khi lưu / máy chủ cập nhật) → nạp lại lưới, giữ nguyên thông báo */
  version: string;
  initialRows: GridRow[];
  saved: Record<string, SavedInfo>;
  variants: VariantRef[];
  subtotal: string;
  fxRate: string;
  currency: "USD" | "VND";
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    ensureTrailingBlank(
      initialRows.map((r) => withKey(r, variants)),
      variants,
    ),
  );
  const [serverIssues, setServerIssues] = useState<RowIssue[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [loadedVersion, setLoadedVersion] = useState(version);
  if (version !== loadedVersion) {
    // dữ liệu đã lưu đổi → nạp lại lưới theo máy chủ (điều chỉnh state trong lúc render, không cần effect)
    setLoadedVersion(version);
    setRows(
      ensureTrailingBlank(
        initialRows.map((r) => withKey(r, variants)),
        variants,
      ),
    );
  }
  const tableRef = useRef<HTMLTableElement>(null);
  const dirty = useRef(false);

  // rời trang khi lưới chưa lưu → trình duyệt hỏi lại (không mất công nhập)
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const { issues } = useMemo(() => validateGrid(rows, variants), [rows, variants]);
  // lỗi (đỏ) được ưu tiên hiện trước cảnh báo (vàng) khi cùng một ô
  const allIssues = useMemo(
    () => [...serverIssues, ...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)),
    [issues, serverIssues],
  );
  const issueAt = (row: number, field: GridField) => allIssues.find((i) => i.row === row && i.field === field);
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const filled = rows.filter((r) => !isBlankRow(r));
  const total = sumPrices(filled);
  const subtotalOk = Number(total) === Number(subtotal);
  const fx4 = BigInt((parseDecimalInput(fxRate, 4) ?? "0").replace(".", ""));
  const approxVnd = (BigInt(total.replace(".", "")) * fx4 + 500_000n) / 1_000_000n;

  function update(k: number, patch: Partial<Row>) {
    dirty.current = true;
    setServerIssues([]);
    setResult(null);
    setRows((prev) =>
      ensureTrailingBlank(
        prev.map((r, i) => (i === k ? { ...r, ...patch } : r)),
        variants,
      ),
    );
  }

  function setVariantText(k: number, text: string) {
    const m = matchVariant(text, variants);
    update(k, { variantText: text, variantId: m?.id ?? "" });
  }

  /** Mã quét/dán nhầm cột (vd IMEI vào ô Serial) → tự chuyển sang đúng cột; Part No. có trong danh mục → tự điền cấu hình. */
  function placeCode(k: number, field: GridField) {
    const r = rows[k];
    const raw = r[field].trim();
    if (!raw) return;
    const c = classifyCode(raw);
    const patch: Partial<Row> = {};
    const target: GridField | null =
      c.kind === "IMEI"
        ? field === "imei2" || (r.imei1 && r.imei1 !== raw)
          ? "imei2"
          : "imei1"
        : c.kind === "SERIAL" && /[A-Z]/.test(c.value)
          ? "serial"
          : c.kind === "PART_NUMBER"
            ? "partNumber"
            : null;
    if (target && target !== field && !r[target]) {
      patch[field] = "";
      patch[target] = c.value;
    } else if (target === field) patch[field] = c.value;
    const part = (patch.partNumber ?? (field === "partNumber" ? c.value : r.partNumber)) || "";
    if (part && !r.variantId) {
      const m = matchVariant(part, variants);
      if (m) Object.assign(patch, { variantId: m.id, variantText: m.label });
    }
    if (Object.keys(patch).length) update(k, patch);
  }

  function focusCell(row: number, col: number) {
    requestAnimationFrame(() => tableRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)?.focus());
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>, row: number, col: number) {
    // Enter = xuống dòng cùng cột (máy quét USB gõ mã + Enter → quét liên tục theo cột)
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const field = COLS[col].field;
      if (CODE_FIELDS.includes(field)) placeCode(row, field);
      focusCell(e.shiftKey ? Math.max(0, row - 1) : row + 1, col);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && row > 0) {
      // Ctrl+D: điền xuống từ dòng trên (cùng cấu hình, cùng đơn giá…)
      e.preventDefault();
      const f = COLS[col].field;
      const above = rows[row - 1];
      update(row, f === "variantId" ? { variantId: above.variantId, variantText: above.variantText } : { [f]: above[f] });
    }
  }

  function onPaste(e: ClipboardEvent<HTMLElement>, row: number) {
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text.trim())) return; // một ô: để trình duyệt dán bình thường
    e.preventDefault();
    const parsed = parsePastedGrid(text, variants);
    if (!parsed.rows.length) return;
    dirty.current = true;
    setServerIssues([]);
    setResult(null);
    setRows((prev) => {
      const next = [...prev];
      let at = row;
      for (const p of parsed.rows) {
        // ghi đè dòng trống (kể cả dòng đang đứng), không ghi đè máy đã có dữ liệu
        while (at < next.length && !isBlankRow(next[at])) at++;
        next.splice(at, at < next.length ? 1 : 0, withKey(p, variants));
        at++;
      }
      return ensureTrailingBlank(next, variants);
    });
    const missing = parsed.rows.filter((r) => !r.variantId).length;
    setNotice(
      `Đã dán ${parsed.rows.length} dòng${parsed.usedHeader ? " (xếp theo tiêu đề cột)" : " (tự nhận IMEI / Serial / Part No. / giá)"}` +
        (missing ? ` · ${missing} dòng chưa nhận ra cấu hình — gõ tắt ở cột Cấu hình` : "") +
        (parsed.unplaced.length ? ` · không xếp được: ${parsed.unplaced.map((u) => `"${u.text}"`).join(", ")}` : ""),
    );
  }

  function remove(k: number) {
    dirty.current = true;
    setServerIssues([]);
    setRows((prev) =>
      ensureTrailingBlank(
        prev.filter((_, i) => i !== k),
        variants,
      ),
    );
  }

  function save() {
    start(async () => {
      const payload = rows.map((r) => {
        const { key: _key, variantText: _t, ...rest } = r;
        void _key;
        void _t;
        return rest;
      });
      const r = await saveItemsAction(purchaseOrderId, payload);
      setServerIssues(r.rowIssues ?? []);
      setResult(r.ok ? { ok: true, text: r.message ?? "Đã lưu" } : { ok: false, text: r.error ?? "Chưa lưu được" });
      if (r.ok) dirty.current = false;
    });
  }

  const general = serverIssues.filter((i) => i.row < 0 || !i.field);
  const unit = currency === "USD" ? usd : (s: string) => `${vnd(BigInt(Math.round(Number(s))))} ₫`;

  return (
    <div className="mt-3" data-testid={`grid-${purchaseOrderId}`}>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table ref={tableRef} className="text-sm border-collapse w-max min-w-full" aria-label="Lưới nhập máy">
          <thead className="bg-[var(--bg)] text-left text-muted">
            <tr>
              <th className="p-2 font-medium w-8">#</th>
              {COLS.map((c) => (
                <th key={c.field} className={`p-2 font-medium ${c.width}`}>
                  {c.label}
                </th>
              ))}
              <th className="p-2 font-medium">Trạng thái · giá vốn</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, row) => {
              const info = r.id ? saved[r.id] : undefined;
              const variant = variants.find((v) => v.id === r.variantId);
              return (
                <tr key={r.key} className="border-t border-border align-top" aria-label={`Dòng ${row + 1}`}>
                  <td className="p-2 text-muted tabular-nums">{row + 1}</td>
                  {COLS.map((c, col) => {
                    const issue = issueAt(row, c.field);
                    const cls = `field !min-h-9 !py-1 !px-2 w-full ${c.mono ? "font-mono uppercase" : ""} ${
                      issue?.severity === "error" ? "!border-[var(--danger)]" : issue ? "!border-[var(--warn)]" : ""
                    }`;
                    const common = {
                      "data-cell": `${row}:${col}`,
                      "aria-label": `${c.label.replace(/ \*.*$/, "")} dòng ${row + 1}`,
                      "aria-invalid": issue?.severity === "error" ? true : undefined,
                      title: issue?.message,
                      onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKeyDown(e, row, col),
                      onPaste: (e: ClipboardEvent<HTMLElement>) => onPaste(e, row),
                    };
                    return (
                      <td key={c.field} className={`p-1 ${c.width}`}>
                        {c.field === "variantId" ? (
                          <>
                            <input
                              {...common}
                              className={cls}
                              list="ds-cau-hinh"
                              value={r.variantText}
                              placeholder="vd: pm 256 sil"
                              onChange={(e) => setVariantText(row, e.target.value)}
                              onBlur={() => variant && r.variantText !== variant.label && update(row, { variantText: variant.label })}
                            />
                            {r.variantText && !variant && <div className="text-xs text-danger px-1">chưa khớp cấu hình nào</div>}
                          </>
                        ) : c.field === "condition" ? (
                          <select {...common} className={cls} value={r.condition} onChange={(e) => update(row, { condition: e.target.value })}>
                            {CONDITIONS.map((k) => (
                              <option key={k} value={k}>
                                {CONDITION_LABEL[k]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            {...common}
                            className={cls}
                            value={r[c.field]}
                            inputMode={c.inputMode}
                            autoCapitalize={c.mono ? "characters" : undefined}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={
                              c.field === "weightKg" && variant?.defaultWeightKg ? String(Number(variant.defaultWeightKg)).replace(".", ",") : undefined
                            }
                            onChange={(e) => update(row, { [c.field]: e.target.value })}
                            onBlur={() => CODE_FIELDS.includes(c.field) && placeCode(row, c.field)}
                          />
                        )}
                        {issue && (
                          <div
                            className={`text-xs px-1 ${issue.severity === "error" ? "text-danger" : "text-[var(--warn)]"}`}
                            role={issue.severity === "error" ? "alert" : undefined}
                          >
                            {issue.message}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className="p-2 text-xs whitespace-nowrap">
                    {info ? (
                      <>
                        <a href={`/kho/${r.id}`} className="underline">
                          {ITEM_STATUS_LABEL[info.status] ?? info.status}
                        </a>
                        <div className="tabular-nums text-muted">
                          {vnd(info.landedCostVnd)} ₫{info.hasEstimate ? " · tạm tính" : ""}
                        </div>
                      </>
                    ) : !isBlankRow(r) ? (
                      <span className="text-muted">mới — chưa lưu</span>
                    ) : null}
                  </td>
                  <td className="p-1">
                    {!isBlankRow(r) && (
                      <button
                        type="button"
                        className="btn-danger !min-h-9 !px-2"
                        aria-label={`Xoá dòng ${row + 1}`}
                        disabled={info?.locked}
                        title={info?.locked ? "Máy đã vào kiện hoặc đã bán — không xoá khỏi đơn được" : "Xoá dòng"}
                        onClick={() => remove(row)}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <datalist id="ds-cau-hinh">
          {variants.map((v) => (
            <option key={v.id} value={v.label}>
              {v.sku}
            </option>
          ))}
        </datalist>
      </div>

      <p className="mt-2 text-xs text-muted">
        Dán nhiều dòng từ Excel / Google Sheets (Ctrl+V vào bất kỳ ô nào) · Enter: xuống dòng cùng cột — máy quét USB quét liên tục được · Ctrl+D: điền xuống từ
        dòng trên · mã quét nhầm cột tự chuyển đúng chỗ.
      </p>
      {notice && (
        <p className="mt-1 text-sm" role="status">
          {notice}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span>
          <b>{filled.length}</b> máy
        </span>
        <span className={subtotalOk ? "text-[var(--ok)]" : "text-[var(--warn)]"} data-testid="subtotal-check">
          Σ đơn giá {unit(total)} {subtotalOk ? "= Subtotal ✓" : `≠ Subtotal ${unit(subtotal)} (lệch ${unit(String(Number(total) - Number(subtotal)))})`}
        </span>
        {currency === "USD" && <span className="text-muted">≈ {vnd(approxVnd)} ₫ theo tỷ giá đơn</span>}
        <span className="grow" />
        {errorCount > 0 && <span className="text-danger">{errorCount} ô lỗi</span>}
        <button type="button" className="btn-primary" disabled={pending || errorCount > 0} onClick={save}>
          {pending ? "Đang lưu…" : "Lưu lưới máy"}
        </button>
      </div>
      {result && (
        <p role={result.ok ? "status" : "alert"} className={`mt-2 text-sm ${result.ok ? "text-[var(--ok)]" : "text-danger"}`}>
          {result.ok ? "✓ " : ""}
          {result.text}
        </p>
      )}
      {general.map((g) => (
        <p key={g.message} role="alert" className="mt-1 text-sm text-danger">
          {g.message}
        </p>
      ))}
    </div>
  );
}
