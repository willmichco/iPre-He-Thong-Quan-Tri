import { Secret, TOTP } from "otpauth";
import type { OwnerConfig } from "./config";
import { verifyPassword } from "./password";

export function makeTotp(secretBase32: string, label = "chu-hang") {
  return new TOTP({
    issuer: "iPre",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** Kiểm tra mã 6 số; chấp nhận lệch ±1 bước (30 giây) do đồng hồ điện thoại. */
export function verifyTotp(secretBase32: string, code: string, timestamp = Date.now()): boolean {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  return makeTotp(secretBase32).validate({ token: clean, window: 1, timestamp }) !== null;
}

export type LoginCheck = { ok: true } | { ok: false; reason: "INVALID" };

/**
 * Kiểm tra đủ cả 3 yếu tố. Luôn chạy so khớp mật khẩu (kể cả khi email sai)
 * để thời gian phản hồi không tiết lộ email đúng hay sai.
 */
export async function checkCredentials(
  cfg: OwnerConfig,
  email: string,
  password: string,
  code: string,
  timestamp = Date.now(),
): Promise<LoginCheck> {
  const emailOk = email.trim().toLowerCase() === cfg.email;
  const passwordOk = await verifyPassword(password, cfg.passwordHash);
  const codeOk = verifyTotp(cfg.totpSecret, code, timestamp);
  return emailOk && passwordOk && codeOk ? { ok: true } : { ok: false, reason: "INVALID" };
}
