/** Cài đặt & xuất toàn bộ dữ liệu ↔ PostgreSQL thật (đã nạp db/seed-vi-du.sql). Ghi trong transaction rồi HUỶ. */
import { inflateRawSync } from "node:zlib";
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { exportAllData, EXPORT_TABLES, getSettings, saveSettings } from "@/server/settings/service";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử tích hợp cần DATABASE_URL trỏ tới CSDL đã chạy `npm run db:seed`");
const sql = postgres(url, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

class Rollback extends Error {}
async function inTx(fn: (tx: TransactionSql) => Promise<void>) {
  await sql
    .begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

/** Đọc tên + nội dung các tệp trong ZIP (thư mục trung tâm). */
function unzip(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let k = 0; k < buf.readUInt16LE(end + 10); k++) {
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const start = off + 30 + buf.readUInt16LE(off + 26);
    out.set(buf.subarray(p + 46, p + 46 + nameLen).toString(), inflateRawSync(buf.subarray(start, start + csize)).toString());
    p += 46 + nameLen;
  }
  return out;
}

describe("Cài đặt ↔ PostgreSQL", () => {
  it("đọc giá trị ví dụ; lưu chỉ cái thay đổi (có nhật ký); lỗi → không lưu gì", async () => {
    await inTx(async (tx) => {
      expect(await getSettings(tx)).toMatchObject({ "alert.aging_days": 30, "tax.revenue_threshold_vnd": 1_000_000_000, "tax.threshold_warning_ratio": 0.8 });
      const n = await saveSettings(tx, {
        "alert.aging_days": "45",
        "alert.eta_grace_days": "2",
        "tax.threshold_warning_ratio": "75",
        "costing.returned_item_policy": "WRITE_OFF",
      });
      expect(n).toBe(3);
      expect(await getSettings(tx)).toMatchObject({ "alert.aging_days": 45, "tax.threshold_warning_ratio": 0.75, "costing.returned_item_policy": "WRITE_OFF" });
      const logs = await tx<{ before: { key: string; value: unknown }; after: { value: unknown } }[]>`
        SELECT before, after FROM audit_logs WHERE entity_type = 'app_setting' ORDER BY id DESC LIMIT 3`;
      expect(logs.map((l) => [l.before.key, l.before.value, l.after.value]).sort()).toEqual([
        ["alert.aging_days", 30, 45],
        ["costing.returned_item_policy", null, "WRITE_OFF"],
        ["tax.threshold_warning_ratio", 0.8, 0.75],
      ]);
      await expect(saveSettings(tx, { "alert.aging_days": "60", "tax.revenue_threshold_vnd": "abc" })).rejects.toMatchObject({
        errors: { "tax.revenue_threshold_vnd": expect.any(String) },
      });
      expect((await getSettings(tx))["alert.aging_days"]).toBe(45);
      expect(await saveSettings(tx, { "alert.aging_days": "45" })).toBe(0);
      // cài đặt chưa từng lưu: gửi đúng giá trị mặc định → không tính là thay đổi
      await tx`DELETE FROM app_settings WHERE key = 'costing.returned_item_policy'`;
      expect(await saveSettings(tx, { "costing.returned_item_policy": "REALLOCATE" })).toBe(0);
    });
  });

  it("xuất toàn bộ dữ liệu: mỗi bảng một CSV có BOM, số dòng khớp, kèm hướng dẫn", async () => {
    const out = await exportAllData(sql, new Date("2026-11-05T03:04:05Z"));
    expect(out.filename).toBe("ipre-du-lieu-20261105-030405.zip");
    const files = unzip(out.zip);
    expect([...files.keys()]).toEqual(["DOC-TRUOC.txt", ...EXPORT_TABLES.map((t) => `${t}.csv`)]);
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM items`;
    expect(out.counts.items).toBe(n);
    const items = files.get("items.csv")!;
    expect(items.startsWith("﻿id,batch_id,purchase_order_id,variant_id")).toBe(true);
    expect(items).toContain("SERIALAIRPODS1");
    expect(items.trimEnd().split("\r\n")).toHaveLength(n + 1);
    expect(files.get("DOC-TRUOC.txt")).toContain(`items.csv: ${n} dòng`);
  });
});
