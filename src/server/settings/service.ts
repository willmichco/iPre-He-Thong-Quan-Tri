/**
 * Cài đặt (app_settings) và xuất toàn bộ dữ liệu.
 */
import type { Sql, TransactionSql } from "postgres";
import { defaultStored, parseSetting, SETTINGS } from "@/domain/settings";
import { zip } from "@/server/zip";

type Db = Sql | TransactionSql;

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly errors: Record<string, string>,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

/** Giá trị đang lưu của các cài đặt đã biết (jsonb → JS). */
export async function getSettings(db: Db): Promise<Record<string, unknown>> {
  const rows = await db<{ key: string; value: unknown; updated_at: string }[]>`
    SELECT key, value FROM app_settings WHERE key = ANY(${SETTINGS.map((s) => s.key)})`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Lưu các cài đặt từ form (khoá → chuỗi). Kiểm tra hết trước khi lưu; chỉ ghi và ghi nhật ký những giá trị thay đổi. */
export async function saveSettings(db: Db, input: Record<string, string>): Promise<number> {
  const errors: Record<string, string> = {};
  const parsed: [string, number | string][] = [];
  for (const d of SETTINGS) {
    if (!(d.key in input)) continue;
    const r = parseSetting(d, input[d.key]);
    if (r.ok) parsed.push([d.key, r.value]);
    else errors[d.key] = r.error;
  }
  if (Object.keys(errors).length) throw new SettingsError(Object.values(errors).join("; "), errors);
  return db.begin(async (tx) => {
    const current = await getSettings(tx);
    let changed = 0;
    for (const [key, value] of parsed) {
      // chưa lưu = đang dùng mặc định → lưu đúng giá trị mặc định không tính là thay đổi
      const effective = key in current ? current[key] : defaultStored(SETTINGS.find((d) => d.key === key)!);
      if (JSON.stringify(effective) === JSON.stringify(value)) continue;
      await tx`
        INSERT INTO app_settings (key, value, updated_at) VALUES (${key}, ${tx.json(value)}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      await tx`INSERT INTO audit_logs (action, entity_type, before, after)
               VALUES ('UPDATE', 'app_setting', ${tx.json({ key, value: current[key] ?? null } as never)}, ${tx.json({ key, value })})`;
      changed++;
    }
    return changed;
  });
}

// ---- Xuất toàn bộ dữ liệu -------------------------------------------------------------------------------

/** Bảng xuất ra (thứ tự: danh mục → nghiệp vụ → nhật ký). Danh sách cố định — không ghép tên bảng từ dữ liệu người dùng. */
export const EXPORT_TABLES = [
  "product_models",
  "product_variants",
  "variant_codes",
  "suppliers",
  "carriers",
  "accounts",
  "cash_categories",
  "customers",
  "exchange_rates",
  "batches",
  "purchase_orders",
  "items",
  "shipments",
  "shipment_items",
  "shipment_tracking_events",
  "item_events",
  "costs",
  "cost_manual_shares",
  "item_cost_allocations",
  "sales",
  "sale_items",
  "sale_expenses",
  "cash_transactions",
  "account_reconciliations",
  "attachments",
  "scan_captures",
  "app_settings",
  "tracking_runs",
  // trợ lý: phiếu đã ghi / huỷ và bảng kê nháp (tin nhắn trò chuyện KHÔNG xuất — chứa dữ liệu cá nhân, có hạn lưu)
  "chat_actions",
  "bang_ke_nhap",
  "audit_logs",
] as const;

/** Một ô CSV (RFC 4180): ngoặc kép khi có dấu phẩy / ngoặc kép / xuống dòng; JSON cho đối tượng. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : typeof v === "bigint" ? v.toString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Toàn bộ dữ liệu: một tệp CSV (UTF-8 có BOM — mở thẳng bằng Excel) cho mỗi bảng, đóng trong một tệp ZIP, kèm hướng dẫn.
 * Chạy trong một transaction REPEATABLE READ chỉ đọc → mọi bảng cùng một thời điểm, khớp nhau.
 */
export async function exportAllData(sql: Sql, now = new Date()): Promise<{ filename: string; zip: Buffer; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const files: { name: string; data: string }[] = [];
  await sql.begin("isolation level repeatable read read only", async (tx) => {
    for (const t of EXPORT_TABLES) {
      const rows = await tx.unsafe(`SELECT * FROM ${t} ORDER BY 1`);
      const cols = rows.columns.map((c) => c.name);
      const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell((r as Record<string, unknown>)[c])).join(","))];
      files.push({ name: `${t}.csv`, data: `﻿${lines.join("\r\n")}\r\n` });
      counts[t] = rows.length;
    }
  });
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  files.unshift({
    name: "DOC-TRUOC.txt",
    data: [
      `iPre — xuất toàn bộ dữ liệu lúc ${now.toISOString()} (UTC)`,
      "",
      "Mỗi bảng một tệp CSV (UTF-8, dấu phẩy, dòng đầu là tên cột). Tiền VND là số nguyên; thời điểm theo ISO 8601.",
      "Tệp chứng từ (ảnh / PDF) không nằm trong gói này — bảng attachments ghi khoá lưu trữ (file_key) và mã băm sha256 để đối chiếu.",
      "Gói này chứa thông tin khách hàng (dữ liệu cá nhân): lưu giữ an toàn, không chia sẻ.",
      "",
      ...EXPORT_TABLES.map((t) => `${t}.csv: ${counts[t]} dòng`),
      "",
    ].join("\r\n"),
  });
  return { filename: `ipre-du-lieu-${stamp}.zip`, zip: zip(files), counts };
}
