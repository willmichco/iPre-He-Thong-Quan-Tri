import type { Metadata } from "next";
import { readOwnerConfig } from "@/server/auth/config";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Đăng nhập · iPre" };

export default async function LoginPage({ searchParams }: PageProps<"/dang-nhap">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  const configured = readOwnerConfig() !== null;
  return (
    <main className="min-h-dvh grid place-items-center p-4">
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-xl font-bold">iPre — Hệ thống quản trị</h1>
        <p className="mt-1 mb-6 text-sm text-muted">Đăng nhập tài khoản chủ hàng</p>
        {configured ? (
          <LoginForm next={next} />
        ) : (
          <p className="text-sm text-danger">
            Chưa cấu hình tài khoản chủ. Chạy <code>npm run auth:setup</code> rồi đặt các biến môi trường theo hướng dẫn.
          </p>
        )}
      </div>
    </main>
  );
}
