import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import { QuickSell } from "./QuickSell";
import { BackLink } from "../../_components/BackLink";

export const metadata = { title: "Bán nhanh" };

export default async function QuickSellPage({ searchParams }: PageProps<"/ban-hang/moi">) {
  const db = await catalogDb();
  const raw = (await searchParams).code;
  const code = Array.isArray(raw) ? raw[0] : raw;
  return (
    <main className="mx-auto max-w-xl p-4 md:p-8">
      <BackLink href="/ban-hang">Bán hàng</BackLink>
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
