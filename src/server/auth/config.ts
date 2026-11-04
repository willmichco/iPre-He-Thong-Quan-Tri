/**
 * Cấu hình tài khoản chủ (một người dùng duy nhất) — đọc từ biến môi trường.
 * Tạo các giá trị này bằng: npm run auth:setup
 */
export interface OwnerConfig {
  email: string;
  passwordHash: string;
  totpSecret: string;
  sessionSecret: string;
}

export function readOwnerConfig(): OwnerConfig | null {
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.OWNER_PASSWORD_HASH?.trim();
  const totpSecret = process.env.OWNER_TOTP_SECRET?.trim();
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (!email || !passwordHash || !totpSecret || !sessionSecret || sessionSecret.length < 32) return null;
  return { email, passwordHash, totpSecret, sessionSecret };
}

/** Chế độ phát triển chưa cấu hình đăng nhập: cho vào thẳng, có cảnh báo. Môi trường thật: luôn chặn. */
export function devBypassAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && readOwnerConfig() === null;
}
