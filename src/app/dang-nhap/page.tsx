import type { Metadata } from "next";
import { readOwnerConfig } from "@/server/auth/config";
import { BrandMark } from "../(app)/_components/BrandMark";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Đăng nhập · iPre" };

export default async function LoginPage({ searchParams }: PageProps<"/dang-nhap">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  const configured = readOwnerConfig() !== null;
  return (
    <main className="min-h-dvh grid place-items-center p-4">
      <div className="glass-strong w-full max-w-sm rounded-[28px] p-7">
        <BrandMark className="h-12 w-12" />
        <h1 className="mt-4 text-[22px] font-bold">iPre — Hệ thống quản trị</h1>
        <p className="mt-1 mb-6 text-sm text-muted">Đăng nhập tài khoản chủ hàng · xác thực 2 lớp</p>
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
