/**
 * Nhật ký kiểm toán với PostgreSQL thật. Mỗi ca chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseAuditFilter } from "@/domain/audit";
import { listAudit, PAGE_SIZE } from "@/server/audit/service";

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

const ID = "a0d17000-0000-0000-0000-000000000001";

describe("Nhật ký kiểm toán ↔ PostgreSQL", () => {
  it("lọc theo đối tượng, thao tác, ngày (giờ VN), mã, nội dung; mới → cũ; phân trang", async () => {
    await inTx(async (tx) => {
      await tx`INSERT INTO audit_logs (occurred_at, action, entity_type, entity_id, before, after) VALUES
        ('2026-11-01T16:59:00Z', 'CREATE', 'shipment', ${ID}, NULL, ${tx.json({ trackingNumber: "TRK-AUD-1", tag: "AUDTEST" })}),
        ('2026-11-01T17:01:00Z', 'UPDATE', 'shipment', ${ID}, ${tx.json({ status: "IN_TRANSIT" })}, ${tx.json({ status: "ARRIVED", tag: "AUDTEST" })}),
        ('2026-11-03T03:00:00Z', 'UPDATE', 'sale', NULL, NULL, ${tx.json({ serial: "F2LX_AUD%", tag: "AUDTEST" })})`;
      const f = (sp: Record<string, string>) => parseAuditFilter({ q: "AUDTEST", ...sp });

      const all = await listAudit(tx, f({}));
      expect(all.rows.map((r) => r.action)).toEqual(["UPDATE", "UPDATE", "CREATE"]);
      expect(all.next).toBeNull();
      expect(all.rows[2]).toMatchObject({ at: "01/11/2026 23:59:00", entityType: "shipment", entityId: ID, after: { trackingNumber: "TRK-AUD-1" } });

      expect((await listAudit(tx, f({ loai: "shipment", "thao-tac": "UPDATE" }))).rows).toHaveLength(1);
      expect((await listAudit(tx, f({ id: ID, q: "" }))).rows).toHaveLength(2);
      // 17:01Z = 00:01 ngày 02/11 giờ VN → thuộc ngày 02, không thuộc ngày 01
      expect((await listAudit(tx, f({ tu: "2026-11-01", den: "2026-11-01" }))).rows.map((r) => r.action)).toEqual(["CREATE"]);
      expect((await listAudit(tx, f({ tu: "2026-11-02" }))).rows).toHaveLength(2);
      // tìm trong nội dung, không phân biệt hoa thường; ký tự % _ được hiểu đúng nghĩa đen
      expect((await listAudit(tx, f({ q: "trk-aud" }))).rows).toHaveLength(1);
      expect((await listAudit(tx, f({ q: "F2LX_AUD%" }))).rows).toHaveLength(1);
      expect((await listAudit(tx, f({ q: "F2LXXAUD" }))).rows).toHaveLength(0);
      expect((await listAudit(tx, f({ q: ID.slice(0, 13) }))).rows).toHaveLength(2);

      await tx`INSERT INTO audit_logs (action, entity_type, after) SELECT 'CREATE', 'cost', ${tx.json({ tag: "AUDPAGE" })} FROM generate_series(1, ${PAGE_SIZE + 2})`;
      const p1 = await listAudit(tx, f({ q: "AUDPAGE" }));
      expect(p1.rows).toHaveLength(PAGE_SIZE);
      expect(p1.next).not.toBeNull();
      const p2 = await listAudit(tx, f({ q: "AUDPAGE", truoc: String(p1.next) }));
      expect(p2.rows).toHaveLength(2);
      expect(p2.rows[0].id).toBeLessThan(p1.rows[PAGE_SIZE - 1].id);
      expect(p2.next).toBeNull();
    });
  });

  it("nhật ký chỉ thêm: sửa / xoá / truncate đều bị từ chối", async () => {
    for (const stmt of [
      (tx: TransactionSql) => tx`UPDATE audit_logs SET action = 'DELETE' WHERE id = (SELECT max(id) FROM audit_logs)`,
      (tx: TransactionSql) => tx`DELETE FROM audit_logs WHERE id = (SELECT max(id) FROM audit_logs)`,
      (tx: TransactionSql) => tx`TRUNCATE audit_logs`,
    ])
      await expect(
        inTx(async (tx) => {
          await tx`INSERT INTO audit_logs (action, entity_type) VALUES ('CREATE', 'cost')`;
          await stmt(tx);
        }),
      ).rejects.toThrow(/chỉ được thêm dòng/);
  });

  it("đơn bán mới: nhật ký không chứa tên / SĐT khách, chỉ mã khách", async () => {
    const leaks = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM audit_logs WHERE after ? 'customerPhone' OR after ? 'customerName'`;
    expect(leaks[0].n).toBe(0);
  });
});
