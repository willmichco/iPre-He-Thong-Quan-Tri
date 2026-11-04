"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Email</span>
        <input name="email" type="email" required autoComplete="username" className="field" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Mật khẩu</span>
        <input name="password" type="password" required autoComplete="current-password" className="field" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Mã xác thực 6 số (ứng dụng Authenticator)</span>
        <input
          name="code"
          inputMode="numeric"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoComplete="one-time-code"
          className="field tracking-[0.3em]"
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? "Đang kiểm tra…" : "Đăng nhập"}
      </button>
    </form>
  );
}
