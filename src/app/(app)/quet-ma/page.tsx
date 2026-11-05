import type { Metadata } from "next";
import Link from "next/link";
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
    <>
      <p className="mx-auto flex max-w-5xl justify-end px-4 pt-3 text-sm md:px-8">
        <Link href="/quet-ma/hop-cho" className="underline" data-testid="inbox-link">
          Hộp chờ duyệt{pending ? ` (${pending})` : ""} →
        </Link>
      </p>
      <ScannerClient />
    </>
  );
}
