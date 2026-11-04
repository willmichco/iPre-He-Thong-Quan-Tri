import type { Metadata } from "next";
import { ScannerClient } from "./ScannerClient";

export const metadata: Metadata = { title: "Quét mã · iPre" };

export default function ScanPage() {
  return <ScannerClient />;
}
