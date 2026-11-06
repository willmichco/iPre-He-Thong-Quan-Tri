import { describe, expect, it } from "vitest";
import {
  carrierOf,
  detectTracking,
  humanDuration,
  nextBotRun,
  statusFromText,
  trackingAlerts,
  upsCheckDigitOk,
  vnShort,
  zonedLocalToIso,
  type TrackedShipment,
} from "@/domain/tracking";
import { parse17, parseUps } from "@/server/tracking/providers";

// Mã mẫu hợp lệ (đúng số kiểm tra) — KHÔNG phải vận đơn thật
const UPS_NO = "1Z999AA10123456784";

describe("nhận biết vận đơn từ link / mã", () => {
  it("số kiểm tra UPS", () => {
    expect(upsCheckDigitOk(UPS_NO)).toBe(true);
    expect(upsCheckDigitOk("1Z999AA10123456785")).toBe(false);
  });

  it("link UPS (trackNums, tracknum, InquiryNumber1) → UPS + mã", () => {
    expect(detectTracking(`https://www.ups.com/track?track=yes&trackNums=${UPS_NO}&loc=en_US&requester=ST/trackdetails`)).toEqual([
      { carrier: "UPS", number: UPS_NO },
    ]);
    expect(detectTracking(`https://www.ups.com/track?loc=en_US&tracknum=${UPS_NO.toLowerCase()}`)).toEqual([{ carrier: "UPS", number: UPS_NO }]);
    expect(detectTracking(`https://wwwapps.ups.com/WebTracking/processInputRequest?InquiryNumber1=${UPS_NO}`)).toEqual([{ carrier: "UPS", number: UPS_NO }]);
  });

  it("link USPS / FedEx / DHL", () => {
    expect(detectTracking("https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490")).toEqual([
      { carrier: "USPS", number: "9400111899223197428490" },
    ]);
    expect(detectTracking("https://www.fedex.com/fedextrack/?trknbr=123456789012")).toEqual([{ carrier: "FEDEX", number: "123456789012" }]);
    expect(detectTracking("https://www.dhl.com/us-en/home/tracking.html?tracking-id=1234567890&submit=1")).toEqual([{ carrier: "DHL", number: "1234567890" }]);
  });

  it("mã trơn, nhiều mã, khoảng trắng, trùng", () => {
    expect(detectTracking(`${UPS_NO.slice(0, 6)} ${UPS_NO.slice(6)}`)).toEqual([]); // tách đôi = 2 mã hỏng
    expect(detectTracking(`${UPS_NO}, 9400111899223197428490\n${UPS_NO}`)).toEqual([
      { carrier: "UPS", number: UPS_NO },
      { carrier: "USPS", number: "9400111899223197428490" },
    ]);
    expect(carrierOf("1z999aa1-0123-456784")).toBe("UPS");
  });

  it("mã sai số kiểm tra / văn bản lạ / link không phải hãng → bỏ", () => {
    expect(detectTracking("1Z999AA10123456785")).toEqual([]);
    expect(detectTracking("xin chào")).toEqual([]);
    expect(detectTracking("https://example.com/?id=abc")).toEqual([]);
    expect(detectTracking("https://exa mple")).toEqual([]);
  });
});

describe("múi giờ", () => {
  it("Arizona (MST, không đổi giờ) → UTC", () => {
    expect(zonedLocalToIso("2026-11-03T17:05", "America/Phoenix")).toBe("2026-11-04T00:05:00.000Z");
    expect(zonedLocalToIso("2026-07-03T17:05", "America/Phoenix")).toBe("2026-07-04T00:05:00.000Z");
  });
  it("Oregon: giờ chuẩn PST mùa đông, PDT mùa hè", () => {
    expect(zonedLocalToIso("2026-11-07T10:00", "America/Los_Angeles")).toBe("2026-11-07T18:00:00.000Z");
    expect(zonedLocalToIso("2026-07-07T10:00", "America/Los_Angeles")).toBe("2026-07-07T17:00:00.000Z");
    // ngày đổi giờ 01/11/2026: 01:30 xảy ra 2 lần — lấy lần đầu (PDT); 03:00 sau đổi giờ là PST
    expect(zonedLocalToIso("2026-11-01T03:00", "America/Los_Angeles")).toBe("2026-11-01T11:00:00.000Z");
  });
  it("giờ VN, giá trị hỏng, múi giờ lạ", () => {
    expect(zonedLocalToIso("2026-11-04T07:05", "Asia/Ho_Chi_Minh")).toBe("2026-11-04T00:05:00.000Z");
    expect(zonedLocalToIso("2026-02-30T10:00", "America/Phoenix")).toBeNull();
    expect(zonedLocalToIso("hôm qua", "America/Phoenix")).toBeNull();
    expect(zonedLocalToIso("2026-11-03T17:05", "Europe/Paris")).toBeNull();
  });
  it("hiển thị giờ VN, khoảng thời gian", () => {
    expect(vnShort("2026-11-04T00:05:00Z")).toBe("04/11 07:05");
    expect(vnShort(null)).toBe("—");
    expect(humanDuration("2026-11-03T04:56:00Z", "2026-11-04T00:05:00Z")).toBe("19 giờ 09 phút");
    expect(humanDuration("2026-11-04T00:05:00Z", "2026-11-07T18:00:00Z")).toBe("3 ngày 17 giờ");
    expect(humanDuration("2026-11-04T00:05:00Z", "2026-11-04T00:30:00Z")).toBe("25 phút");
    expect(humanDuration("2026-11-05T00:00:00Z", "2026-11-04T00:00:00Z")).toBeNull();
  });
});

describe("lịch bot 07:00 + 19:00 giờ VN", () => {
  it("lần chạy kế tiếp", () => {
    expect(nextBotRun(new Date("2026-11-06T03:00:00+07:00"))).toBe("2026-11-06T00:00:00.000Z"); // 03:00 VN → 07:00 VN
    expect(nextBotRun(new Date("2026-11-06T07:00:00+07:00"))).toBe("2026-11-06T12:00:00.000Z"); // đúng 07:00 → 19:00
    expect(nextBotRun(new Date("2026-11-06T21:30:00+07:00"))).toBe("2026-11-07T00:00:00.000Z"); // tối → sáng mai
  });
});

/** Phản hồi UPS Track API mô phỏng hành trình Phoenix AZ → Oregon (UPS Ground), có báo trễ 1 ngày. */
const upsBody = (extra: object[] = [], pkg: object = {}) => ({
  trackResponse: {
    shipment: [
      {
        package: [
          {
            trackingNumber: UPS_NO,
            currentStatus: { description: "On the Way", code: "IT" },
            deliveryDate: [{ type: "RDD", date: "20261107" }],
            deliveryTime: { type: "EOD", startTime: "100000", endTime: "140000" },
            activity: [
              ...extra,
              {
                location: { address: { city: "Salt Lake City", stateProvince: "UT", countryCode: "US" } },
                status: { type: "X", description: "Your delivery has been rescheduled for the next business day.", code: "XY" },
                date: "20261105",
                time: "041100",
                gmtDate: "20261105",
                gmtTime: "11:11:00",
              },
              {
                location: { address: { city: "Salt Lake City", stateProvince: "UT", countryCode: "US" } },
                status: { type: "I", description: "Arrived at Facility", code: "AR" },
                date: "20261104",
                time: "223400",
                gmtOffset: "-07:00",
              },
              {
                location: { address: { city: "Phoenix", stateProvince: "AZ", countryCode: "US" } },
                status: { type: "P", description: "Pickup Scan", code: "PU" },
                date: "20261103",
                time: "170700",
                gmtOffset: "-07:00",
              },
              {
                location: { address: { countryCode: "US" } },
                status: { type: "M", description: "Shipper created a label, UPS has not received the package yet.", code: "MP" },
                date: "20261102",
                time: "215600",
                gmtOffset: "-07:00",
              },
            ],
            ...pkg,
          },
        ],
      },
    ],
  },
});

describe("đọc dữ liệu UPS", () => {
  it("hành trình, trạng thái trễ, hẹn giao, các mốc", () => {
    const r = parseUps(upsBody());
    expect(r.status).toBe("DELAYED");
    expect(r.statusText).toBe("On the Way");
    expect(r.eta).toBe("2026-11-07");
    expect(r.etaWindow).toBe("10:00–14:00");
    expect(r.events).toHaveLength(4);
    expect(r.events[0]).toMatchObject({ at: "2026-11-05T11:11:00.000Z", location: "Salt Lake City, UT, US" });
    expect(r.events[1].at).toBe("2026-11-05T05:34:00.000Z");
    expect(r.labelCreatedAt).toBe("2026-11-03T04:56:00.000Z");
    expect(r.pickedUpAt).toBe("2026-11-04T00:07:00.000Z");
    expect(r.deliveredAt).toBeNull();
    expect(new Set(r.events.map((e) => e.key)).size).toBe(4);
  });

  it("đã giao", () => {
    const r = parseUps(
      upsBody(
        [
          {
            location: { address: { city: "Portland", stateProvince: "OR", countryCode: "US" } },
            status: { type: "D", description: "DELIVERED", code: "FS" },
            date: "20261107",
            time: "113000",
            gmtOffset: "-08:00",
          },
        ],
        { currentStatus: { description: "Delivered" }, deliveryDate: [{ type: "DEL", date: "20261107" }] },
      ),
    );
    expect(r.status).toBe("DELIVERED");
    expect(r.deliveredAt).toBe("2026-11-07T19:30:00.000Z");
    expect(r.eta).toBe("2026-11-07");
  });

  it("chưa có thông tin / phản hồi hỏng", () => {
    expect(parseUps({ trackResponse: { shipment: [{ warnings: [{ message: "Tracking Information Not Found" }] }] } })).toMatchObject({
      status: "NOT_FOUND",
      statusText: "Tracking Information Not Found",
    });
    expect(parseUps(null).status).toBe("NOT_FOUND");
    expect(parseUps({ response: { errors: [{ message: "Invalid tracking number" }] } }).statusText).toBe("Invalid tracking number");
  });
});

describe("đọc dữ liệu 17TRACK", () => {
  it("đang đi + hẹn giao + mốc", () => {
    const r = parse17({
      number: "9400111899223197428490",
      track_info: {
        latest_status: { status: "InTransit" },
        latest_event: { description: "Arrived at USPS Regional Facility" },
        time_metrics: { estimated_delivery_date: { from: "2026-11-08T09:00:00-08:00", to: "2026-11-08T17:00:00-08:00" } },
        milestone: [
          { key_stage: "InfoReceived", time_utc: "2026-11-02T10:00:00Z" },
          { key_stage: "PickedUp", time_utc: "2026-11-03T22:00:00Z" },
          { key_stage: "Delivered", time_utc: null },
        ],
        tracking: {
          providers: [
            {
              events: [
                { time_utc: "2026-11-03T22:00:00Z", description: "USPS in possession of item", location: "PHOENIX, AZ" },
                { time_utc: "2026-11-05T08:00:00Z", description: "Arrived at USPS Regional Facility", location: "PORTLAND OR DISTRIBUTION CENTER" },
              ],
            },
          ],
        },
      },
    });
    expect(r.status).toBe("IN_TRANSIT");
    expect(r.events.map((e) => e.at)).toEqual(["2026-11-05T08:00:00.000Z", "2026-11-03T22:00:00.000Z"]);
    expect(r.eta).toBe("2026-11-08");
    expect(r.etaWindow).toBe("09:00–17:00");
    expect(r.labelCreatedAt).toBe("2026-11-02T10:00:00.000Z");
    expect(r.pickedUpAt).toBe("2026-11-03T22:00:00.000Z");
    expect(r.deliveredAt).toBeNull();
  });
  it("trạng thái lạ / thiếu dữ liệu", () => {
    expect(parse17({ track_info: { latest_status: { status: "Delivered" } } }).status).toBe("DELIVERED");
    expect(parse17({}).status).toBe("NOT_FOUND");
    expect(parse17({ track_info: { latest_status: { status: "InTransit" }, latest_event: { description: "Delivery delayed" } } }).status).toBe("DELAYED");
  });
});

describe("mô tả tiếng Anh của hãng → trạng thái", () => {
  it.each([
    ["DELIVERED", "DELIVERED"],
    ["Your package will be delivered tomorrow", null],
    ["Out For Delivery Today", "OUT_FOR_DELIVERY"],
    ["Delivery will be delayed by one business day", "DELAYED"],
    ["Returned to sender", "EXCEPTION"],
    ["Shipper created a label, UPS has not received the package yet.", "LABEL_CREATED"],
    ["Departed from Facility", null],
  ])("%s", (text, want) => expect(statusFromText(text)).toBe(want));
});

describe("cảnh báo của bot", () => {
  const base: TrackedShipment = {
    id: "s1",
    label: UPS_NO,
    status: "IN_TRANSIT",
    trackStatus: "IN_TRANSIT",
    trackStatusText: "On the Way",
    trackEta: null,
    eta: null,
    lastEventAt: "2026-11-05T11:00:00Z",
    pickedUpAt: null,
    deliveredAt: null,
    checkedAt: null,
    error: null,
  };
  const now = new Date("2026-11-06T12:00:00Z");
  const kinds = (rows: TrackedShipment[]) => trackingAlerts(rows, now).map((a) => `${a.kind}:${a.level}`);

  it("bình thường → không báo", () => expect(kinds([base])).toEqual([]));
  it("hãng báo đã giao mà kiện chưa nhận → nhắc nhận kiện", () => {
    const a = trackingAlerts([{ ...base, trackStatus: "DELIVERED", deliveredAt: "2026-11-07T19:30:00Z" }], now);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "TRACK_DELIVERED", level: "warning", href: "/van-chuyen/s1" });
    expect(a[0].title).toContain("08/11 02:30");
  });
  it("kiện chờ gửi mà hãng đã nhận hàng → gợi ý bấm Gửi đi", () => {
    expect(kinds([{ ...base, status: "PLANNED", pickedUpAt: "2026-11-04T00:07:00Z" }])).toEqual(["TRACK_PICKED_UP:info"]);
    expect(kinds([{ ...base, status: "PLANNED", trackStatus: "LABEL_CREATED" }])).toEqual([]);
  });
  it("trễ / sự cố / hẹn muộn hơn dự kiến / lâu không cập nhật", () => {
    expect(kinds([{ ...base, trackStatus: "DELAYED", trackEta: "2026-11-07" }])).toEqual(["TRACK_PROBLEM:warning"]);
    expect(kinds([{ ...base, trackStatus: "EXCEPTION" }])).toEqual(["TRACK_PROBLEM:critical"]);
    expect(kinds([{ ...base, trackEta: "2026-11-07", eta: "2026-11-06" }])).toEqual(["TRACK_ETA_CHANGED:info"]);
    expect(kinds([{ ...base, trackEta: "2026-11-06", eta: "2026-11-07" }])).toEqual([]);
    expect(kinds([{ ...base, lastEventAt: "2026-11-02T00:00:00Z" }])).toEqual(["TRACK_STALE:info"]);
  });
  it("lỗi đọc vận đơn gộp thành 1 dòng", () => {
    const err = { ...base, trackStatus: null, error: "Chưa có khoá API để theo dõi UPS" };
    const a = trackingAlerts([err, { ...err, id: "s2" }], now);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "TRACK_ERROR", title: "Bot chưa đọc được 2 vận đơn", href: "/van-chuyen" });
  });
});

describe("gọi API hãng (fetch giả lập)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("không có khoá → không có nguồn", async () => {
    const { providersFromEnv } = await import("@/server/tracking/providers");
    expect(providersFromEnv({})).toEqual({ UPS: undefined, USPS: undefined, FEDEX: undefined, DHL: undefined });
    const p = providersFromEnv({ TRACK17_API_KEY: "k" });
    expect(p.UPS?.name).toBe("17TRACK");
    expect(providersFromEnv({ UPS_CLIENT_ID: "a", UPS_CLIENT_SECRET: "b", TRACK17_API_KEY: "k" }).UPS?.name).toBe("UPS API");
  });

  it("UPS: lấy mã truy cập 1 lần rồi tra cứu", async () => {
    const { upsProvider } = await import("@/server/tracking/providers");
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).includes("/oauth/token")) {
        expect(String((init?.headers as Record<string, string>).Authorization)).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
        return json({ access_token: "T", expires_in: "14399" });
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer T");
      return json(upsBody());
    }) as typeof fetch;
    try {
      const p = upsProvider({ UPS_CLIENT_ID: "id", UPS_CLIENT_SECRET: "secret", UPS_API_BASE: "https://ups.test" })!;
      expect((await p.track("UPS", UPS_NO)).status).toBe("DELAYED");
      await p.track("UPS", UPS_NO);
      expect(calls).toEqual([
        "POST https://ups.test/security/v1/oauth/token",
        `GET https://ups.test/api/track/v1/details/${UPS_NO}?locale=en_US&returnSignature=false`,
        `GET https://ups.test/api/track/v1/details/${UPS_NO}?locale=en_US&returnSignature=false`,
      ]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("UPS: khoá sai / hãng lỗi / mất mạng → lỗi dễ hiểu", async () => {
    const { upsProvider } = await import("@/server/tracking/providers");
    const orig = globalThis.fetch;
    const run = async (f: () => Response | Promise<Response>) => {
      globalThis.fetch = (async () => f()) as typeof fetch;
      try {
        await upsProvider({ UPS_CLIENT_ID: "id", UPS_CLIENT_SECRET: "s", UPS_API_BASE: "https://ups.test" })!.track("UPS", UPS_NO);
        return null;
      } catch (e) {
        return e as { message: string; transient: boolean };
      } finally {
        globalThis.fetch = orig;
      }
    };
    expect((await run(() => json({}, 401)))?.message).toBe("Khoá API bị từ chối — kiểm tra lại khoá");
    expect((await run(() => json({}, 503)))?.transient).toBe(true);
    expect((await run(() => Promise.reject(new TypeError("fetch failed"))))?.message).toContain("Không kết nối được");
  });

  it("17TRACK: số chưa đăng ký → đăng ký rồi hỏi lại", async () => {
    const { track17Provider } = await import("@/server/tracking/providers");
    const paths: string[] = [];
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      paths.push(String(url).split("/").pop()!);
      expect((init?.headers as Record<string, string>)["17token"]).toBe("k");
      expect(JSON.parse(String(init?.body))).toEqual([{ number: "9400111899223197428490", carrier: 21051 }]);
      if (String(url).endsWith("register")) return json({ code: 0, data: { accepted: [{}] } });
      return n++ === 0
        ? json({
            code: 0,
            data: {
              accepted: [],
              rejected: [{ number: "9400111899223197428490", error: { code: -18019902, message: "The tracking number is not registered" } }],
            },
          })
        : json({ code: 0, data: { accepted: [{ number: "9400111899223197428490", track_info: { latest_status: { status: "InfoReceived" } } }] } });
    }) as typeof fetch;
    try {
      const r = await track17Provider({ TRACK17_API_KEY: "k", TRACK17_API_BASE: "https://17.test" })!.track("USPS", "9400111899223197428490");
      expect(r.status).toBe("LABEL_CREATED");
      expect(paths).toEqual(["gettrackinfo", "register", "gettrackinfo"]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
