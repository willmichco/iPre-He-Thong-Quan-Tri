import { describe, expect, it } from "vitest";
import { backupName, parseBackupName, pgMajor, retention, toolMismatch } from "@/domain/backup";
import { decrypt, encrypt } from "@/server/backup/service";
import { unzip, zip } from "@/server/zip";

const KEY = "khoa-kiem-thu-du-dai-0123456789";

describe("Sao lưu — tên tệp & chính sách giữ bản", () => {
  it("tên theo giờ UTC, đọc lại được; tên lạ / ngày sai → null", () => {
    const t = new Date("2026-11-04T19:00:00Z");
    expect(backupName(t)).toBe("ipre-20261104-190000.ipbak");
    expect(parseBackupName("ipre-20261104-190000.ipbak")).toEqual(t);
    expect(parseBackupName("ipre-20260230-190000.ipbak")).toBeNull();
    expect(parseBackupName("ghi-chu.txt")).toBeNull();
  });
  it("giữ bản mới nhất mỗi ngày (30 ngày) + mỗi tháng (12 tháng); không đụng tệp lạ", () => {
    // 2 bản/ngày trong 400 ngày, lúc 02:00 và 14:00 giờ VN
    const names: string[] = [];
    const start = Date.UTC(2026, 10, 5, 19); // 06/11 02:00 VN
    for (let d = 0; d < 400; d++) for (const h of [0, 12]) names.push(backupName(new Date(start - d * 86_400_000 + h * 3_600_000)));
    const r = retention([...names, "ghi-chu.txt"]);
    expect(r.keep.length + r.remove.length).toBe(800);
    expect(r.remove).not.toContain("ghi-chu.txt");
    expect(r.keep[0]).toBe("ipre-20261106-070000.ipbak"); // mới nhất
    const days = new Set(r.keep.map((n) => new Date(parseBackupName(n)!.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)));
    const months = new Set(r.keep.map((n) => new Date(parseBackupName(n)!.getTime() + 7 * 3_600_000).toISOString().slice(0, 7)));
    expect(days.size).toBe(r.keep.length); // mỗi ngày giữ đúng một bản
    expect(months.size).toBe(12);
    // 30 ngày gần nhất (08/10 → 06/11) đã chứa bản mới nhất của tháng 11 và tháng 10 → 2 tháng trùng
    expect(r.keep.length).toBe(30 + 12 - 2);
    expect(retention([])).toEqual({ keep: [], remove: [] });
    expect(retention(["ipre-20261104-190000.ipbak"], { days: 0, months: 0 }).keep).toEqual(["ipre-20261104-190000.ipbak"]); // luôn giữ bản mới nhất
  });
});

describe("Sao lưu — phiên bản công cụ PostgreSQL", () => {
  it("đọc phiên bản; pg_dump không cũ hơn máy chủ, pg_restore không mới hơn máy chủ đích", () => {
    expect(pgMajor("pg_restore (PostgreSQL) 17.2 (Ubuntu 17.2-1.pgdg24.04+1)")).toBe(17);
    expect(pgMajor("pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)")).toBe(16);
    expect(pgMajor("lạ")).toBeNull();
    expect(toolMismatch("pg_restore", 17, 16)).toContain("pg_restore 17 mới hơn máy chủ đích PostgreSQL 16");
    expect(toolMismatch("pg_restore", 16, 16)).toBeNull();
    expect(toolMismatch("pg_restore", 15, 16)).toBeNull();
    expect(toolMismatch("pg_dump", 15, 16)).toContain("pg_dump 15 cũ hơn máy chủ PostgreSQL 16");
    expect(toolMismatch("pg_dump", 17, 16)).toBeNull();
    expect(toolMismatch("pg_dump", null, 16)).toBeNull();
  });
});

describe("Sao lưu — mã hoá & ZIP", () => {
  it("mã hoá AES-256-GCM: giải mã đúng khoá; sai khoá / sửa 1 byte / không phải tệp sao lưu → lỗi", () => {
    const plain = Buffer.from("dữ liệu mật ".repeat(1000));
    const enc = encrypt(plain, KEY);
    expect(enc.subarray(0, 8).toString()).toBe("IPREBAK1");
    expect(enc.includes(Buffer.from("dữ liệu mật"))).toBe(false);
    expect(decrypt(enc, KEY).equals(plain)).toBe(true);
    expect(encrypt(plain, KEY).equals(enc)).toBe(false); // salt / iv ngẫu nhiên
    expect(() => decrypt(enc, "khoa-sai-nhung-du-dai-000000")).toThrow(/sai BACKUP_KEY/);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decrypt(tampered, KEY)).toThrow(/bị hỏng/);
    expect(() => decrypt(Buffer.from("PK\u0003\u0004 khong phai"), KEY)).toThrow(/Không phải tệp sao lưu/);
    expect(() => encrypt(plain, "ngan")).toThrow(/quá ngắn/);
  });
  it("ZIP đọc lại đúng (deflate và store), phát hiện hỏng, chặn tên tệp nguy hiểm", () => {
    const files = [
      { name: "a.txt", data: "xin chào" },
      { name: "chung-tu/2026/11/x.pdf", data: Buffer.from([0, 1, 2, 255]) },
    ];
    for (const store of [false, true]) {
      const back = unzip(zip(files, { store }));
      expect(back.get("a.txt")!.toString()).toBe("xin chào");
      expect([...back.get("chung-tu/2026/11/x.pdf")!]).toEqual([0, 1, 2, 255]);
    }
    const z = zip([{ name: "a.txt", data: "abcdef" }], { store: true });
    const bad = Buffer.from(z);
    bad[30 + 5] ^= 0xff; // sửa nội dung tệp
    expect(() => unzip(bad)).toThrow(/CRC/);
    expect(() => unzip(zip([{ name: "../ngoai.txt", data: "x" }]))).toThrow(/không an toàn/);
    expect(() => unzip(Buffer.from("khong phai zip"))).toThrow(/Không phải tệp ZIP/);
  });
});
