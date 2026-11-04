"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { INITIAL_STATE, type FormState } from "./state";

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

const FormCtx = createContext<{ pending: boolean; errors: Record<string, string> }>({ pending: false, errors: {} });

/**
 * Form gọi Server Action. Lỗi hiện ngay dưới từng ô và KHÔNG xoá dữ liệu đã gõ; lưu xong mới xoá trắng
 * (`resetOnSuccess`, dùng cho form "thêm mới"). `confirm` = hỏi lại trước khi gửi (vd. xoá).
 */
export function ActionForm({
  action,
  children,
  resetOnSuccess = false,
  confirm,
  className = "",
  label,
}: {
  action: Action;
  children: ReactNode;
  resetOnSuccess?: boolean;
  confirm?: string;
  className?: string;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.seq > 0 && resetOnSuccess) ref.current?.reset();
  }, [state.seq, resetOnSuccess]);
  return (
    <FormCtx.Provider value={{ pending, errors: state.ok ? {} : (state.fieldErrors ?? {}) }}>
      <form
        ref={ref}
        aria-label={label}
        className={className}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm && !window.confirm(confirm)) return;
          const fd = new FormData(e.currentTarget);
          startTransition(() => formAction(fd));
        }}
      >
        {children}
        {!pending && state.error && (
          <p role="alert" className="mt-2 text-sm text-danger basis-full">
            {state.error}
          </p>
        )}
        {!pending && state.ok && state.message && (
          <p role="status" className="mt-2 text-sm text-[var(--ok)] basis-full">
            ✓ {state.message}
          </p>
        )}
      </form>
    </FormCtx.Provider>
  );
}

function useFieldError(name: string) {
  return useContext(FormCtx).errors[name];
}

export function Input({ label, name, hint, className = "", ...rest }: { label: string; name: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const error = useFieldError(name);
  const id = `f${useId().replace(/:/g, "")}-${name}`;
  return (
    <label className={`flex flex-col gap-1 text-sm ${className}`} htmlFor={id}>
      <span className="text-muted">{label}</span>
      <input id={id} name={name} className="field" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} {...rest} />
      {error ? (
        <span id={`${id}-err`} className="text-xs text-danger">
          {error}
        </span>
      ) : (
        hint && <span className="text-xs text-muted">{hint}</span>
      )}
    </label>
  );
}

export function Select({
  label,
  name,
  options,
  className = "",
  ...rest
}: { label: string; name: string; options: readonly (readonly [string, string])[] } & SelectHTMLAttributes<HTMLSelectElement>) {
  const error = useFieldError(name);
  return (
    <label className={`flex flex-col gap-1 text-sm ${className}`}>
      <span className="text-muted">{label}</span>
      <select name={name} className="field" aria-invalid={error ? true : undefined} {...rest}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Checkbox({ label, name, defaultChecked, value = "on" }: { label: string; name: string; defaultChecked?: boolean; value?: string }) {
  return (
    <label className="flex items-center gap-2 text-sm min-h-[44px]">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} className="size-5" />
      {label}
    </label>
  );
}

/** Nhóm ô chọn nhiều (vd. các chặng); lỗi của nhóm hiện bên dưới. */
export function CheckboxGroup({
  label,
  name,
  options,
  defaults = [],
}: {
  label: string;
  name: string;
  options: readonly (readonly [string, string])[];
  defaults?: string[];
}) {
  const error = useFieldError(name);
  return (
    <fieldset className="flex flex-col gap-1 text-sm basis-full">
      <legend className="text-muted mb-1">{label}</legend>
      <div className="flex flex-wrap gap-x-4">
        {options.map(([v, l]) => (
          <Checkbox key={v} label={l} name={name} value={v} defaultChecked={defaults.includes(v)} />
        ))}
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
    </fieldset>
  );
}

export function Submit({ children, variant = "primary" }: { children: ReactNode; variant?: "primary" | "secondary" | "danger" }) {
  const { pending } = useContext(FormCtx);
  const cls = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-secondary";
  return (
    <button type="submit" className={cls} disabled={pending}>
      {pending ? "Đang lưu…" : children}
    </button>
  );
}

export function Tabs({ tabs }: { tabs: readonly { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Mục danh mục" className="mt-4 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t) => {
        const active = t.href === "/danh-muc" ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px ${active ? "border-primary text-primary font-semibold" : "border-transparent text-muted"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
