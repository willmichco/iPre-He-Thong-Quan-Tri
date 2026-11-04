import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { devBypassAllowed, readOwnerConfig } from "./config";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSessionToken, verifySessionToken } from "./session-token";

export interface CurrentOwner {
  email: string;
  /** true khi chạy máy phát triển chưa cấu hình đăng nhập. */
  devBypass: boolean;
}

/**
 * Lớp truy cập dữ liệu (DAL): mọi trang, Server Action và Route Handler gọi hàm này
 * để tự kiểm tra phiên — không chỉ dựa vào proxy.ts.
 * Bọc `cache` của React: layout và trang trong CÙNG một yêu cầu chỉ kiểm tra phiên một lần (mỗi yêu cầu vẫn kiểm tra).
 */
export const requireOwner = cache(async function requireOwner(): Promise<CurrentOwner> {
  // Đọc cookie TRƯỚC mọi nhánh: buộc trang render theo từng yêu cầu, không bao giờ bị dựng tĩnh lúc build.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (devBypassAllowed()) return { email: "dev@localhost", devBypass: true };
  const cfg = readOwnerConfig();
  if (!cfg) redirect("/dang-nhap");
  const claims = await verifySessionToken(token, cfg.sessionSecret, cfg.email);
  if (!claims) redirect("/dang-nhap");
  return { email: claims.sub, devBypass: false };
});

export async function startSession(email: string, sessionSecret: string) {
  const token = await signSessionToken(email, sessionSecret);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}
