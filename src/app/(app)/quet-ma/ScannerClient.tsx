"use client";

import dynamic from "next/dynamic";
import { submitScansAction } from "./actions";
import { PartNumberInfo } from "./PartNumberInfo";

// Bộ quét dùng camera, WebAssembly và localStorage → chỉ chạy trên trình duyệt.
const Scanner = dynamic(() => import("@/features/scanner/Scanner").then((m) => m.Scanner), {
  ssr: false,
  loading: () => <p className="p-6 text-muted">Đang tải bộ quét…</p>,
});

const WASM = { url: "/wasm/zxing_reader.wasm" };
const partInfo = (code: string) => <PartNumberInfo code={code} />;

export function ScannerClient() {
  return <Scanner wasm={WASM} ocrBase="/ocr" sampleLabelUrl="/nhan-mau.svg" renderPartNumberInfo={partInfo} onSubmit={submitScansAction} />;
}
