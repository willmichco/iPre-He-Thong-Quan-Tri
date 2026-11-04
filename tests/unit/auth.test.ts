import { Secret } from "otpauth";
import { describe, expect, it } from "vitest";
import type { OwnerConfig } from "@/server/auth/config";
import { checkCredentials, makeTotp, verifyTotp } from "@/server/auth/credentials";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { isLocked, recordFailure, recordSuccess, resetRateLimit } from "@/server/auth/rate-limit";
import { signSessionToken, verifySessionToken, SESSION_TTL_SECONDS } from "@/server/auth/session-token";

describe("mật khẩu (scrypt)", () => {
  it("xác minh đúng mật khẩu, từ chối mật khẩu sai và chuỗi băm hỏng", async () => {
    const hash = await hashPassword("mat-khau-rat-dai-2026");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("mat-khau-rat-dai-2026", hash)).toBe(true);
    expect(await verifyPassword("mat-khau-sai", hash)).toBe(false);
    expect(await verifyPassword("x", "khong-hop-le")).toBe(false);
  });
  it("hai lần băm cùng mật khẩu cho kết quả khác nhau (có muối)", async () => {
    expect(await hashPassword("abcdefghijkl")).not.toBe(await hashPassword("abcdefghijkl"));
  });
});

describe("mã xác thực 2 lớp (TOTP)", () => {
  const secret = new Secret({ size: 20 }).base32;
  const now = Date.UTC(2026, 10, 4, 8, 0, 0);
  const code = makeTotp(secret).generate({ timestamp: now });

  it("chấp nhận mã hiện tại và mã lệch 30 giây", () => {
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, code, now + 30_000)).toBe(true);
    expect(verifyTotp(secret, code.slice(0, 3) + " " + code.slice(3), now)).toBe(true);
  });
  it("từ chối mã cũ hơn 1 phút và mã sai định dạng", () => {
    expect(verifyTotp(secret, code, now + 120_000)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
    expect(verifyTotp(secret, "abcdef", now)).toBe(false);
  });
});

describe("đăng nhập đủ 3 yếu tố", () => {
  it("chỉ thành công khi email + mật khẩu + mã đều đúng", async () => {
    const secret = new Secret({ size: 20 }).base32;
    const now = Date.UTC(2026, 10, 4, 8, 0, 0);
    const cfg: OwnerConfig = {
      email: "chu@ipre.vn",
      passwordHash: await hashPassword("mat-khau-rat-dai-2026"),
      totpSecret: secret,
      sessionSecret: "x".repeat(48),
    };
    const code = makeTotp(secret).generate({ timestamp: now });
    expect((await checkCredentials(cfg, "Chu@iPre.vn ", "mat-khau-rat-dai-2026", code, now)).ok).toBe(true);
    expect((await checkCredentials(cfg, "khac@ipre.vn", "mat-khau-rat-dai-2026", code, now)).ok).toBe(false);
    expect((await checkCredentials(cfg, "chu@ipre.vn", "sai", code, now)).ok).toBe(false);
    expect((await checkCredentials(cfg, "chu@ipre.vn", "mat-khau-rat-dai-2026", "000000", now)).ok).toBe(false);
  });
});

describe("phiên đăng nhập (JWT)", () => {
  const secret = "s".repeat(48);
  it("xác minh phiên hợp lệ; từ chối sai khoá, sai email, hết hạn", async () => {
    const token = await signSessionToken("chu@ipre.vn", secret);
    expect((await verifySessionToken(token, secret, "chu@ipre.vn"))?.sub).toBe("chu@ipre.vn");
    expect(await verifySessionToken(token, "k".repeat(48), "chu@ipre.vn")).toBeNull();
    expect(await verifySessionToken(token, secret, "khac@ipre.vn")).toBeNull();
    const old = await signSessionToken("chu@ipre.vn", secret, Date.now() - (SESSION_TTL_SECONDS + 60) * 1000);
    expect(await verifySessionToken(old, secret, "chu@ipre.vn")).toBeNull();
    expect(await verifySessionToken(undefined, secret, "chu@ipre.vn")).toBeNull();
  });
});

describe("chống dò mật khẩu", () => {
  it("khoá sau 5 lần sai, mở khi đăng nhập đúng", () => {
    resetRateLimit();
    const t = Date.now();
    for (let i = 0; i < 4; i++) recordFailure("ip", t);
    expect(isLocked("ip", t)).toBe(0);
    recordFailure("ip", t);
    expect(isLocked("ip", t)).toBeGreaterThan(0);
    recordSuccess("ip");
    expect(isLocked("ip", t)).toBe(0);
  });
});
