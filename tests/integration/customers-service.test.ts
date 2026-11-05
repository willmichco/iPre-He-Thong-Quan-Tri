/** Khách hàng ↔ PostgreSQL thật (đã nạp db/seed-vi-du.sql). Mỗi ca chạy trong transaction rồi HUỶ. */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import * as svc from "@/server/customers/service";

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

const KHACH_A = "b0000000-0000-0000-0000-000000000001";
const input = (o: Partial<Parameters<typeof svc.saveCustomer>[2]> = {}) => ({
  fullName: "Anh Minh",
  phone: "0987654321",
  zalo: null,
  facebook: null,
  address: "Q.3, TP.HCM",
  note: null,
  ...o,
});

describe("Khách hàng ↔ PostgreSQL", () => {
  it("danh sách & hồ sơ khách ví dụ: đơn, doanh thu, máy đã mua, bảo hành", async () => {
    const list = await svc.listCustomers(sql);
    expect(list.find((c) => c.id === KHACH_A)).toMatchObject({
      fullName: "Khách A",
      phone: "0900000001",
      orders: 1,
      revenueVnd: 34_500_000n,
      balanceVnd: 0n,
      lastPurchase: "2026-10-23",
    });
    expect((await svc.listCustomers(sql, "090 000 0002")).map((c) => c.fullName)).toEqual(["Khách B"]);
    expect(await svc.listCustomers(sql, "không-có-ai")).toEqual([]);
    const c = (await svc.getCustomer(sql, KHACH_A))!;
    expect(c.sales.map((s) => [s.code, s.totalVnd, s.balanceVnd])).toEqual([["BH-2026-0001", 34_500_000n, 0n]]);
    expect(c.items).toMatchObject([{ serial: "SERIALIPHONE01", warrantyUntil: "2027-04-23", returned: false }]);
    expect(await svc.getCustomer(sql, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("thêm / sửa; số điện thoại không trùng khách khác; nhật ký không lưu thông tin cá nhân", async () => {
    await inTx(async (tx) => {
      const id = await svc.saveCustomer(tx, null, input());
      await expect(svc.saveCustomer(tx, null, input({ fullName: "Trùng", phone: "0900000001" }))).rejects.toMatchObject({ code: "DUPLICATE", field: "phone" });
      await svc.saveCustomer(tx, id, input({ fullName: "Anh Minh (Q3)", phone: "0987654321" }));
      expect((await svc.getCustomer(tx, id))!.fullName).toBe("Anh Minh (Q3)");
      const logs = await tx<{ after: unknown }[]>`SELECT after FROM audit_logs WHERE entity_type = 'customer' AND entity_id = ${id} ORDER BY id`;
      expect(logs.map((l) => l.after)).toEqual([{ fields: ["full_name", "phone", "zalo", "facebook", "address", "note"] }, { changed: ["full_name"] }]);
      expect(JSON.stringify(logs)).not.toContain("0987654321");
    });
  });

  it("ẩn danh hoá: xoá thông tin cá nhân, giữ đơn bán; không sửa được nữa; số điện thoại dùng lại được", async () => {
    await inTx(async (tx) => {
      await expect(svc.anonymizeCustomer(tx, KHACH_A, "x")).rejects.toMatchObject({ field: "reason" });
      await svc.anonymizeCustomer(tx, KHACH_A, "Khách yêu cầu qua Zalo 05/11");
      const c = (await svc.getCustomer(tx, KHACH_A))!;
      expect(c).toMatchObject({ fullName: "Khách đã ẩn danh #B00000", phone: null, address: null, anonymized: true });
      expect(c.sales).toHaveLength(1); // giao dịch vẫn còn
      expect((await svc.listCustomers(tx)).some((x) => x.id === KHACH_A)).toBe(false);
      await expect(svc.saveCustomer(tx, KHACH_A, input())).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(svc.anonymizeCustomer(tx, KHACH_A, "lần nữa")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await svc.saveCustomer(tx, null, input({ phone: "0900000001" })); // số cũ đã được giải phóng
    });
  });
});
