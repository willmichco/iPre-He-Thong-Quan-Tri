import type { Metadata } from "next";
import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";
import { inboxCount } from "@/server/scans/service";
import { ScannerClient } from "./ScannerClient";

export const metadata: Metadata = { title: "Quét mã · iPre" };

export default async function ScanPage() {
  await requireOwner();
  const db = getSql();
  const pending = db ? await inboxCount(db) : 0;
  return (
    <main className="md:px-4 md:pt-4">
      <ScannerClient pending={pending} />
    </main>
  );
}
