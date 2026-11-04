"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CodeLookup } from "@/server/catalog/service";
import { lookupCodesAction } from "../danh-muc/actions";

/** Bộ nhớ đệm trong phiên: mỗi mã chỉ hỏi máy chủ một lần (null = không có trong danh mục). */
const cache = new Map<string, Promise<CodeLookup | null>>();
function lookup(code: string) {
  let p = cache.get(code);
  if (!p) {
    p = lookupCodesAction([code]).then(
      (rows) => rows[0] ?? null,
      () => {
        cache.delete(code); // lỗi mạng → lần sau hỏi lại
        return undefined as unknown as null;
      },
    );
    cache.set(code, p);
  }
  return p;
}

/** Dòng dưới thẻ máy trong bộ quét: Part No. → cấu hình (danh mục), hoặc nút gán mã nếu chưa có. */
export function PartNumberInfo({ code }: { code: string }) {
  const [state, setState] = useState<{ code: string; hit: CodeLookup | null | undefined } | null>(null);
  useEffect(() => {
    let live = true;
    lookup(code).then((hit) => live && setState({ code, hit }));
    return () => {
      live = false;
    };
  }, [code]);
  if (!state || state.code !== code || state.hit === undefined) return null;
  const { hit } = state;
  if (!hit)
    return (
      <p className="sc-issue sc-issue-warn" data-testid="part-info">
        Mã {code} chưa có trong danh mục —{" "}
        <Link href={`/danh-muc/ma-may?code=${encodeURIComponent(code)}`} className="underline">
          gán cấu hình một lần
        </Link>{" "}
        để lần sau tự nhận ra.
      </p>
    );
  return (
    <p className="sc-extras" data-testid="part-info">
      ✓ {hit.label}
      {hit.defaultWeightKg ? ` · ${Number(hit.defaultWeightKg).toLocaleString("vi-VN")} kg` : ""}
      {!hit.isActive ? " · (cấu hình đã ngừng dùng)" : ""}
    </p>
  );
}
