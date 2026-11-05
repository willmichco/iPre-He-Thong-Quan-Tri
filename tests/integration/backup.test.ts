/**
 * Diễn tập khôi phục (tài liệu 06, rủi ro #4): sao lưu CSDL kiểm thử + thư mục chứng từ → khôi phục vào một CSDL MỚI
 * → so từng bảng (số dòng + mã băm nội dung) và số liệu chuyến ví dụ. Cần pg_dump / pg_restore và quyền tạo CSDL.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, verifyBackup } from "@/server/backup/service";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử tích hợp cần DATABASE_URL trỏ tới CSDL đã chạy `npm run db:seed`");
const KEY = "khoa-dien-tap-khoi-phuc-0123456789";
const dir = mkdtempSync(join(tmpdir(), "ipre-sao-luu-"));
const target = new URL(url);
target.pathname = `/ipre_khoi_phuc_${process.pid}`;
const admin = postgres(url, { max: 1, onnotice: () => {} });
afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${target.pathname.slice(1)}" WITH (FORCE)`);
  await admin.end();
  rmSync(dir, { recursive: true, force: true });
});

/** Mỗi bảng: số dòng + md5 của toàn bộ nội dung xếp theo khoá chính (thứ tự cột cố định). */
async function fingerprint(dbUrl: string) {
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ t: string }[]>`
      SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`;
    const out: Record<string, string> = {};
    for (const { t } of tables) {
      const [r] = await sql.unsafe(`SELECT COUNT(*) AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`);
      out[t] = `${r.n}:${r.h}`;
    }
    const [b] = await sql`SELECT total_landed_cost_vnd||'|'||realized_profit_vnd||'|'||roi_on_sold_pct AS s FROM v_batch_summary WHERE code = 'CH-2026-011'`;
    return { tables: out, batch: b?.s as string | undefined };
  } finally {
    await sql.end();
  }
}

describe("Sao lưu ↔ khôi phục (PostgreSQL thật)", () => {
  it("sao lưu mã hoá → kiểm tra → khôi phục vào CSDL mới: mọi bảng giống hệt, chứng từ đủ", async () => {
    const docsA = join(dir, "chung-tu-a");
    const docsB = join(dir, "chung-tu-b");
    const key = `2026/11/${"b".repeat(64)}.pdf`;
    mkdirSync(join(docsA, "2026", "11"), { recursive: true });
    writeFileSync(join(docsA, key), "%PDF-1.4 hoá đơn");

    const before = await fingerprint(url);
    const b = await createBackup({ databaseUrl: url, attachmentsDir: docsA, outDir: join(dir, "bk"), secret: KEY, now: new Date("2026-11-04T19:00:00Z") });
    expect(b.path.endsWith("ipre-20261104-190000.ipbak")).toBe(true);
    expect(b.manifest.attachments.count).toBe(1);
    expect(b.manifest.migrations).toContain("0005_so_quy.sql");
    expect(readFileSync(b.path).includes(Buffer.from("SERIALAIRPODS1"))).toBe(false); // đã mã hoá

    const v = await verifyBackup(b.path, KEY);
    expect(v.tables).toBeGreaterThanOrEqual(25);
    await expect(verifyBackup(b.path, "khoa-sai-nhung-du-dai-00000000")).rejects.toThrow(/sai BACKUP_KEY/);

    await admin.unsafe(`CREATE DATABASE "${target.pathname.slice(1)}"`);
    const r = await restoreBackup({ file: b.path, secret: KEY, targetUrl: target.toString(), attachmentsDir: docsB });
    expect(r.restoredFiles).toBe(1);
    expect(readFileSync(join(docsB, key)).toString()).toBe("%PDF-1.4 hoá đơn");

    const after = await fingerprint(target.toString());
    expect(after.tables).toEqual(before.tables);
    expect(after.batch).toBe("55943208|2706128|5.53");

    // khôi phục lần 2 lên chính CSDL đó (ghi đè): vẫn giống hệt, không chép lại tệp đã có
    const again = await restoreBackup({ file: b.path, secret: KEY, targetUrl: target.toString(), attachmentsDir: docsB });
    expect(again.restoredFiles).toBe(0);
    expect((await fingerprint(target.toString())).tables).toEqual(before.tables);
  }, 120_000);
});
