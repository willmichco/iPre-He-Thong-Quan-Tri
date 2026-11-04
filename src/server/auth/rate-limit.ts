/**
 * Chống dò mật khẩu: sau 5 lần sai trong 15 phút, khoá đăng nhập từ địa chỉ đó 15 phút.
 * Lưu trong bộ nhớ tiến trình — đủ cho một máy chủ; khi chạy nhiều phiên bản
 * (serverless) sẽ chuyển sang bảng CSDL ở GĐ1.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const failures = new Map<string, { count: number; first: number; lockedUntil: number }>();

export function isLocked(key: string, now = Date.now()): number {
  const f = failures.get(key);
  if (!f) return 0;
  if (f.lockedUntil > now) return f.lockedUntil - now;
  if (now - f.first > WINDOW_MS) failures.delete(key);
  return 0;
}

export function recordFailure(key: string, now = Date.now()) {
  const f = failures.get(key);
  if (!f || now - f.first > WINDOW_MS) {
    failures.set(key, { count: 1, first: now, lockedUntil: 0 });
    return;
  }
  f.count += 1;
  if (f.count >= MAX_FAILURES) f.lockedUntil = now + WINDOW_MS;
}

export function recordSuccess(key: string) {
  failures.delete(key);
}

export function resetRateLimit() {
  failures.clear();
}
