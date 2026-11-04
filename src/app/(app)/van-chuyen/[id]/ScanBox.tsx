"use client";

import { useEffect, useRef } from "react";

/**
 * Ô quét liên tục: máy quét USB / bàn phím gõ mã + Enter → gửi ngay, ô tự xoá và giữ con trỏ để quét tiếp.
 * Dán nhiều mã (mỗi dòng một mã) rồi Enter cũng được; Shift+Enter để xuống dòng.
 */
export function ScanBox({ label }: { label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <label className="flex flex-col gap-1 text-sm grow min-w-64">
      <span className="text-muted">{label}</span>
      <textarea
        ref={ref}
        name="codes"
        rows={2}
        className="field font-mono uppercase"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        placeholder="Quét Serial / IMEI rồi Enter — hoặc dán nhiều mã"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
    </label>
  );
}
