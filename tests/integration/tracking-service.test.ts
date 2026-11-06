/**
 * Bot theo dõi vận đơn ↔ PostgreSQL (nguồn dữ liệu hãng giả lập). Mỗi ca chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { TrackCarrier, TrackResult } from "@/domain/tracking";
import type { TrackingProvider } from "@/server/tracking/providers";
import { TrackingError } from "@/server/tracking/providers";
import * as bot from "@/server/tracking/service";
import { getShipment, markShipped, ShippingError } from "@/server/shipping/service";

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

const UPS_NO = "1Z999AA10123456784";
const LINK = `https://www.ups.com/track?track=yes&trackNums=${UPS_NO}&loc=en_US&requester=ST/trackdetails`;

const transit: TrackResult = {
  status: "IN_TRANSIT",
  statusText: "On the Way",
  events: [
    { at: "2026-11-05T05:34:00.000Z", location: "Salt Lake City, UT, US", description: "Arrived at Facility", key: "k3" },
    { at: "2026-11-04T00:07:00.000Z", location: "Phoenix, AZ, US", description: "Pickup Scan", key: "k2" },
    { at: "2026-11-03T04:56:00.000Z", location: "US", description: "Shipper created a label", key: "k1" },
  ],
  eta: "2026-11-07",
  etaWindow: "10:00–14:00",
  labelCreatedAt: "2026-11-03T04:56:00.000Z",
  pickedUpAt: "2026-11-04T00:07:00.000Z",
  deliveredAt: null,
};

function fake(results: (TrackResult | Error)[]): { providers: Partial<Record<TrackCarrier, TrackingProvider>>; calls: string[] } {
  const calls: string[] = [];
  const p: TrackingProvider = {
    name: "Giả lập",
    async track(carrier, number) {
      calls.push(`${carrier}:${number}`);
      const r = results.length > 1 ? results.shift()! : results[0];
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { providers: { UPS: p }, calls };
}

const events = async (tx: TransactionSql, id: string) =>
  (await tx<{ d: string; source: string }[]>`SELECT description AS d, source FROM shipment_tracking_events WHERE shipment_id = ${id} ORDER BY occurred_at`).map(
    (r) => `${r.source}:${r.d}`,
  );

describe("Bot theo dõi vận đơn ↔ PostgreSQL", () => {
  it("dán link UPS → tạo đơn vị UPS + kiện chờ gửi, kiểm tra ngay, ghi hành trình + giờ tạo nhãn", async () => {
    await inTx(async (tx) => {
      const { providers, calls } = fake([transit]);
      const r = await bot.trackFromText(tx, `Đơn đầu tiên: ${LINK}`, providers);
      expect(r.added).toEqual([{ id: expect.any(String), number: UPS_NO, carrier: "UPS", created: true }]);
      expect(calls).toEqual([`UPS:${UPS_NO}`]);
      expect(r.run).toMatchObject({ checked: 1, changed: 1, failed: 0, unconfigured: 0 });

      const s = (await getShipment(tx, r.added[0].id))!;
      expect(s).toMatchObject({
        legType: "US_DOMESTIC",
        status: "PLANNED",
        carrierName: "UPS",
        trackingNumber: UPS_NO,
        trackStatus: "IN_TRANSIT",
        trackEta: "2026-11-07",
        trackEtaWindow: "10:00–14:00",
        trackError: null,
      });
      expect(new Date(s.labelCreatedAt!).toISOString()).toBe("2026-11-03T04:56:00.000Z");
      expect(new Date(s.trackPickedUpAt!).toISOString()).toBe("2026-11-04T00:07:00.000Z");
      const [c] = await tx<{ p: string; tpl: string }[]>`SELECT tracking_provider AS p, tracking_url_template AS tpl FROM carriers WHERE name = 'UPS'`;
      expect(c).toEqual({ p: "UPS", tpl: "https://www.ups.com/track?tracknum={tracking}" });
      expect(await events(tx, s.id)).toEqual(["API:Shipper created a label", "API:Pickup Scan", "API:Arrived at Facility"]);

      // dán lại cùng link → không tạo kiện mới
      const again = await bot.trackFromText(tx, UPS_NO, providers);
      expect(again.added).toEqual([{ id: s.id, number: UPS_NO, carrier: "UPS", created: false }]);
      expect((await tx`SELECT 1 FROM shipments WHERE tracking_number = ${UPS_NO}`).length).toBe(1);
    });
  });

  it("chạy nhiều lần không ghi trùng; đổi trạng thái → nhật ký; đã giao → thôi kiểm tra", async () => {
    await inTx(async (tx) => {
      const delivered: TrackResult = {
        ...transit,
        status: "DELIVERED",
        statusText: "Delivered",
        events: [{ at: "2026-11-07T19:30:00.000Z", location: "Portland, OR, US", description: "DELIVERED", key: "k4" }, ...transit.events],
        deliveredAt: "2026-11-07T19:30:00.000Z",
      };
      const { providers, calls } = fake([transit, transit, delivered]);
      const { added } = await bot.trackFromText(tx, UPS_NO, providers);
      const id = added[0].id;
      await markShipped(tx, id, "2026-11-04T00:07:00.000Z").catch((e) => {
        // kiện chưa có máy → không bấm "Gửi đi" được; đặt thẳng trạng thái để thử bot
        if (!(e instanceof ShippingError)) throw e;
      });
      await tx`UPDATE shipments SET status = 'IN_TRANSIT', shipped_at = '2026-11-04T00:07:00Z' WHERE id = ${id}`;

      const second = await bot.runTrackingBot(tx, { trigger: "SCHEDULE", providers, shipmentIds: [id] });
      expect(second).toMatchObject({ checked: 1, changed: 0 });
      expect((await events(tx, id)).length).toBe(3);

      const third = await bot.runTrackingBot(tx, { trigger: "SCHEDULE", providers, shipmentIds: [id] });
      expect(third).toMatchObject({ checked: 1, changed: 1 });
      expect((await events(tx, id)).at(-1)).toBe("API:DELIVERED");
      const s = (await getShipment(tx, id))!;
      expect(s.trackStatus).toBe("DELIVERED");
      expect(s.status).toBe("IN_TRANSIT"); // bot không tự bấm "Đã nhận"
      const audits = await tx<{ after: { trackStatus: string; by?: string } }[]>`
        SELECT after FROM audit_logs WHERE entity_id = ${id} AND after ? 'trackStatus' ORDER BY id`;
      expect(audits.map((a) => a.after.trackStatus)).toEqual(["IN_TRANSIT", "DELIVERED"]);
      expect(audits.every((a) => a.after.by === "bot")).toBe(true);

      const fourth = await bot.runTrackingBot(tx, { trigger: "SCHEDULE", providers, shipmentIds: [id] });
      expect(fourth.checked).toBe(0);
      expect(calls).toHaveLength(3);
    });
  });

  it("lỗi hãng → ghi lỗi trên kiện, lần chạy vẫn xong; thiếu khoá → chưa có nguồn", async () => {
    await inTx(async (tx) => {
      const { providers } = fake([new TrackingError("Hãng trả lỗi HTTP 503", true)]);
      const { added, run } = await bot.trackFromText(tx, UPS_NO, providers);
      expect(run).toMatchObject({ checked: 1, failed: 1 });
      let s = (await getShipment(tx, added[0].id))!;
      expect(s.trackError).toBe("Giả lập: Hãng trả lỗi HTTP 503");
      expect(s.trackStatus).toBeNull();

      const none = await bot.runTrackingBot(tx, { trigger: "MANUAL", providers: {}, shipmentIds: [s.id] });
      expect(none).toMatchObject({ checked: 0, unconfigured: 1 });
      s = (await getShipment(tx, s.id))!;
      expect(s.trackError).toBe("Chưa có khoá API để theo dõi UPS");

      const board = await bot.trackingBoard(tx, {});
      expect(board.configured).toEqual([]);
      expect(board.rows.find((r) => r.id === s.id)).toMatchObject({ trackingNumber: UPS_NO, error: "Chưa có khoá API để theo dõi UPS" });
      expect(board.lastRun).toMatchObject({ trigger: "MANUAL", checked: 0 });
    });
  });

  it("không chạy chồng: đang có lượt dở → lượt theo lịch bỏ qua", async () => {
    await inTx(async (tx) => {
      await tx`INSERT INTO tracking_runs (trigger) VALUES ('SCHEDULE')`;
      expect(await bot.runTrackingBot(tx, { trigger: "SCHEDULE", providers: {} })).toMatchObject({ skipped: true, runId: null });
    });
  });

  it("tắt bot cho kiện; giờ tạo nhãn phải trước giờ gửi", async () => {
    await inTx(async (tx) => {
      const { providers, calls } = fake([transit]);
      const { added } = await bot.trackFromText(tx, UPS_NO, providers);
      const id = added[0].id;
      await bot.setTrackEnabled(tx, id, false);
      await bot.runTrackingBot(tx, { trigger: "SCHEDULE", providers, shipmentIds: [id] });
      expect(calls).toHaveLength(1);
      expect((await bot.trackingBoard(tx, {})).rows.some((r) => r.id === id)).toBe(false);

      await tx`UPDATE shipments SET status = 'IN_TRANSIT', shipped_at = '2026-11-04T00:07:00Z' WHERE id = ${id}`;
      await expect(bot.setLabelCreated(tx, id, "2026-11-05T00:00:00.000Z")).rejects.toMatchObject({ field: "at" });
      await bot.setLabelCreated(tx, id, "2026-11-03T05:00:00.000Z");
      expect(new Date((await getShipment(tx, id))!.labelCreatedAt!).toISOString()).toBe("2026-11-03T05:00:00.000Z");
      await bot.setLabelCreated(tx, id, null);
      expect((await getShipment(tx, id))!.labelCreatedAt).toBeNull();
    });
  });

  it("mã không nhận ra → lỗi ô nhập", async () => {
    await inTx(async (tx) => {
      await expect(bot.trackFromText(tx, "https://example.com/abc", {})).rejects.toMatchObject({ code: "INVALID_INPUT", field: "link" });
    });
  });
});
