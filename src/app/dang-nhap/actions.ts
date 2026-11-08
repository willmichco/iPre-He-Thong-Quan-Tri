"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { readOwnerConfig } from "@/server/auth/config";
import { checkCredentials } from "@/server/auth/credentials";
import { isLocked, recordFailure, recordSuccess } from "@/server/auth/rate-limit";
import { endSession, startSession } from "@/server/auth/session";

export interface LoginState {
  error?: string;
}

function safeNext(value: FormDataEntryValue | null): string {
  const v = typeof value === "string" ? value : "/";
  // chỉ cho chuyển về đường dẫn nội bộ
  return v.startsWith("/") && !v.startsWith("//") ? v : "/";
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const cfg = readOwnerConfig();
  if (!cfg) return { error: "Hệ thống chưa cấu hình tài khoản chủ (xem README → Cấu hình đăng nhập)." };

  const h = await headers();
  const ip = h.get("cf-connecting-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  const lockedMs = isLocked(ip);
  if (lockedMs > 0) {
    return { error: `Sai quá nhiều lần. Thử lại sau ${Math.ceil(lockedMs / 60000)} phút.` };
  }

  const result = await checkCredentials(
    cfg,
    String(formData.get("email") ?? ""),
    String(formData.get("password") ?? ""),
    String(formData.get("code") ?? ""),
  );
  if (!result.ok) {
    recordFailure(ip);
    return { error: "Email, mật khẩu hoặc mã xác thực không đúng." };
  }

  recordSuccess(ip);
  await startSession(cfg.email, cfg.sessionSecret);
  redirect(safeNext(formData.get("next")));
}

export async function logout() {
  await endSession();
  redirect("/dang-nhap");
}
