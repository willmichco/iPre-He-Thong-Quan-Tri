/**
 * Chứng từ đính kèm ↔ PostgreSQL thật + kho tệp trong thư mục tạm. Mỗi ca chạy trong transaction rồi HUỶ.
 * Dữ liệu ví dụ chưa có chứng từ nào → mọi máy còn trong tay (AirPods) thiếu hồ sơ.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres, { type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as svc from "@/server/attachments/service";
import { localStore, setFileStore } from "@/server/attachments/storage";
import { setEinvoiceNo } from "@/server/sales/service";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử tích hợp cần DATABASE_URL trỏ tới CSDL đã chạy `npm run db:seed`");
const sql = postgres(url, { max: 2, onnotice: () => {} });
const dir = mkdtempSync(join(tmpdir(), "ipre-chung-tu-"));
beforeAll(() => setFileStore(localStore(dir)));
afterAll(async () => {
  setFileStore(null);
  rmSync(dir, { recursive: true, force: true });
  await sql.end();
});

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

const PO011 = "70000000-0000-0000-0000-000000000001";
const SHIP_INTL = "90000000-0000-0000-0000-000000000002";
const AIRPODS = "80000000-0000-0000-0000-000000000003";
const SALE1 = "c0000000-0000-0000-0000-000000000001";
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF`);
const files = () => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".pdf"));

describe("Chứng từ ↔ PostgreSQL", () => {
  it("tải lên → danh sách → tải lại cùng tệp bị bỏ qua; cùng nội dung ở đối tượng khác dùng chung một tệp lưu", async () => {
    await inTx(async (tx) => {
      const before = files().length;
      const r = await svc.uploadAttachments(tx, { entityType: "PURCHASE_ORDER", entityId: PO011, kind: "INVOICE" }, [
        { name: "Apple invoice W123456789.pdf", bytes: pdf("invoice") },
        { name: "thanh toán.pdf", bytes: pdf("receipt") },
      ]);
      expect(r).toEqual({ added: 2, duplicates: [] });
      const list = await svc.listAttachments(tx, "PURCHASE_ORDER", [PO011]);
      expect(list.map((d) => [d.kind, d.fileName, d.mimeType])).toEqual([
        ["INVOICE", "Apple invoice W123456789.pdf", "application/pdf"],
        ["INVOICE", "thanh toán.pdf", "application/pdf"],
      ]);
      expect(files().length).toBe(before + 2);

      const again = await svc.uploadAttachments(tx, { entityType: "PURCHASE_ORDER", entityId: PO011, kind: "INVOICE" }, [
        { name: "trùng.pdf", bytes: pdf("invoice") },
      ]);
      expect(again).toEqual({ added: 0, duplicates: ["trùng.pdf"] });
      await svc.uploadAttachments(tx, { entityType: "SALE", entityId: SALE1, kind: "INVOICE" }, [{ name: "hd.pdf", bytes: pdf("invoice") }]);
      expect(files().length).toBe(before + 2); // không lưu thêm bản sao

      const one = (await svc.getAttachment(tx, list[0].id))!;
      expect(one.fileKey).toMatch(/^\d{4}\/\d{2}\/[0-9a-f]{64}\.pdf$/);
      await svc.deleteAttachment(tx, list[0].id);
      expect(await svc.getAttachment(tx, list[0].id)).toBeNull();
      await expect(svc.deleteAttachment(tx, list[0].id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  it("từ chối: tệp không phải ảnh / PDF (không lưu tệp nào), đối tượng không tồn tại, không chọn tệp", async () => {
    await inTx(async (tx) => {
      const before = files().length;
      await expect(
        svc.uploadAttachments(tx, { entityType: "PURCHASE_ORDER", entityId: PO011, kind: "INVOICE" }, [
          { name: "ok.pdf", bytes: pdf("x") },
          { name: "virus.html", bytes: new TextEncoder().encode("<script>") },
        ]),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", field: "files" });
      expect(files().length).toBe(before);
      await expect(
        svc.uploadAttachments(tx, { entityType: "SHIPMENT", entityId: "00000000-0000-0000-0000-000000000000", kind: "AWB" }, [
          { name: "a.pdf", bytes: pdf("a") },
        ]),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(svc.uploadAttachments(tx, { entityType: "SHIPMENT", entityId: SHIP_INTL, kind: "AWB" }, [])).rejects.toMatchObject({ field: "files" });
    });
  });

  it("hồ sơ nguồn gốc của máy: thiếu → thêm hoá đơn mua + vận đơn Mỹ → VN → đủ; danh sách máy thiếu chứng từ cập nhật", async () => {
    await inTx(async (tx) => {
      const d0 = (await svc.itemDossier(tx, AIRPODS))!;
      expect(d0.gaps).toEqual(["PURCHASE", "IMPORT"]);
      expect(d0.sections.map((s) => s.entityType)).toEqual(["PURCHASE_ORDER", "BATCH", "SHIPMENT", "SHIPMENT", "SHIPMENT", "ITEM"]);
      expect(d0.sections[3].title).toContain("Mỹ → VN · AWB-0001");
      expect((await svc.missingDossiers(tx)).map((r) => [r.serial, r.gaps])).toEqual([["SERIALAIRPODS1", ["PURCHASE", "IMPORT"]]]);

      await svc.uploadAttachments(tx, { entityType: "PURCHASE_ORDER", entityId: PO011, kind: "INVOICE" }, [{ name: "inv.pdf", bytes: pdf("inv") }]);
      expect((await svc.itemDossier(tx, AIRPODS))!.gaps).toEqual(["IMPORT"]);
      await svc.uploadAttachments(tx, { entityType: "SHIPMENT", entityId: SHIP_INTL, kind: "AWB" }, [{ name: "awb.pdf", bytes: pdf("awb") }]);
      const d2 = (await svc.itemDossier(tx, AIRPODS))!;
      expect(d2.gaps).toEqual([]);
      expect(d2.sections[3].docs.map((x) => x.fileName)).toEqual(["awb.pdf"]);
      expect(await svc.missingDossiers(tx)).toEqual([]);
      expect(await svc.itemDossier(tx, "00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });

  it("số hoá đơn điện tử của đơn bán: ghi / xoá, có nhật ký", async () => {
    await inTx(async (tx) => {
      await setEinvoiceNo(tx, SALE1, "  1C26TAA-00012 ");
      const [s] = await tx<{ einvoice_no: string | null }[]>`SELECT einvoice_no FROM sales WHERE id = ${SALE1}`;
      expect(s.einvoice_no).toBe("1C26TAA-00012");
      await setEinvoiceNo(tx, SALE1, "");
      const [s2] = await tx<{ einvoice_no: string | null }[]>`SELECT einvoice_no FROM sales WHERE id = ${SALE1}`;
      expect(s2.einvoice_no).toBeNull();
      const [{ n }] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_id = ${SALE1} AND after ? 'einvoiceNo'`;
      expect(n).toBe(2);
    });
  });
});
