"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { submitScansAction } from "./actions";
import { PartNumberInfo } from "./PartNumberInfo";
import { ScannerSkeleton } from "./ScannerSkeleton";

// Bộ quét dùng camera, WebAssembly và localStorage → chỉ chạy trên trình duyệt.
const Scanner = dynamic(() => import("@/features/scanner/Scanner").then((m) => m.Scanner), {
  ssr: false,
  loading: () => <ScannerSkeleton />,
});

const WASM = { url: "/wasm/zxing_reader.wasm" };
const partInfo = (code: string) => <PartNumberInfo code={code} />;

export function ScannerClient({ pending }: { pending: number }) {
  return (
    <Scanner
      wasm={WASM}
      ocrBase="/ocr"
      sampleLabelUrl="/nhan-mau.svg"
      renderPartNumberInfo={partInfo}
      onSubmit={submitScansAction}
      headerExtra={
        <Link href="/quet-ma/hop-cho" className="sc-head-link" data-testid="inbox-link">
          Hộp chờ duyệt{pending ? ` (${pending})` : ""} →
        </Link>
      }
    />
  );
}
