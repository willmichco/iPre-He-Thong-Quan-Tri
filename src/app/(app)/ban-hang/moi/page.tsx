import Link from "next/link";
import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import { QuickSell } from "./QuickSell";

export const metadata = { title: "Bán nhanh" };

export default async function QuickSellPage({ searchParams }: PageProps<"/ban-hang/moi">) {
  const db = await catalogDb();
  const raw = (await searchParams).code;
  const code = Array.isArray(raw) ? raw[0] : raw;
  return (
    <main className="mx-auto max-w-xl p-4 md:p-8">
      <Link href="/ban-hang" className="text-sm text-muted hover:text-text">
        ← Bán hàng
      </Link>
      <h1 className="mt-1 text-2xl font-bold">Bán máy</h1>
      <div className="mt-4">
        {!db ? (
          <NoDatabase />
        ) : (
          <QuickSell
            accounts={await db<
              { id: string; name: string }[]
            >`SELECT id::text, name FROM accounts WHERE is_active AND currency = 'VND' ORDER BY kind <> 'BANK', name`}
            initialCode={code}
          />
        )}
      </div>
    </main>
  );
}
