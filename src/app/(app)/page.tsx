import Link from "next/link";
import { NAV } from "./nav";

export default function OverviewPage() {
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 className="text-2xl font-bold">Tổng quan</h1>
      <p className="mt-1 text-muted">
        Giai đoạn 0 — nền móng. Các số liệu (vốn theo chặng, doanh thu, lãi, tồn kho) sẽ xuất hiện ở đây từ Giai đoạn 1.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {NAV.filter((n) => n.href !== "/").map((n) => (
          <Link key={n.href} href={n.href} className="card p-4 hover:border-primary">
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                <span aria-hidden className="mr-2">
                  {n.icon}
                </span>
                {n.label}
              </span>
              <span className={`text-xs rounded-full px-2 py-0.5 ${n.phase === "GĐ0" ? "bg-primary text-[var(--primary-text)]" : "border border-border text-muted"}`}>
                {n.phase === "GĐ0" ? "Dùng thử được" : n.phase}
              </span>
            </div>
            <p className="mt-2 text-sm text-muted">{n.description}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
