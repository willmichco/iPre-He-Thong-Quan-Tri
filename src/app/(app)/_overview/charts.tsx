/**
 * Biểu đồ của trang Tổng quan — SVG / HTML thuần, chạy phía máy chủ, không cần thư viện.
 * Một màu (xanh chính) cho độ lớn; số âm (lỗ) dùng màu nguy hiểm kèm dấu "−" — không dựa vào màu đơn thuần.
 * Di chuột / chạm vào cột để xem số (thẻ <title>); mỗi biểu đồ có bảng số liệu đi kèm.
 */
import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { shortVnd } from "@/domain/overview";

const monthLabel = (m: string) => `${Number(m.slice(5, 7))}/${m.slice(2, 4)}`;

/** Cột theo tháng (12 cột), một chuỗi số — chuẩn hoá theo |giá trị| lớn nhất, có đường gốc 0. */
export function MonthBars({ title, points, testid }: { title: string; points: readonly { month: string; value: bigint; units: number }[]; testid: string }) {
  const W = 360;
  const H = 150;
  const top = 18;
  const bottom = 22;
  const max = points.reduce((a, p) => (p.value > a ? p.value : -p.value > a ? -p.value : a), 0n);
  const hasNeg = points.some((p) => p.value < 0n);
  const plotH = H - top - bottom;
  const zeroY = hasNeg ? top + plotH / 2 : top + plotH;
  const scale = hasNeg ? plotH / 2 : plotH;
  const slot = W / points.length;
  const barW = Math.max(6, slot - 6);
  const h = (v: bigint) => (max === 0n ? 0 : (Number(v < 0n ? -v : v) / Number(max)) * scale);
  const last = points[points.length - 1];
  const peak = points.reduce((a, p) => (p.value > a.value ? p : a), points[0]);
  return (
    <figure className="card p-4" data-testid={testid}>
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <span className="text-xs text-muted">12 tháng · tháng này {shortVnd(last.value)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full h-auto" role="img" aria-label={`${title} 12 tháng gần nhất`}>
        <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeWidth={1} />
        {points.map((p, k) => {
          const x = k * slot + (slot - barW) / 2;
          const bh = h(p.value);
          const y = p.value < 0n ? zeroY : zeroY - bh;
          const tip = `Tháng ${monthLabel(p.month)}: ${p.value < 0n ? "−" : ""}${formatVnd(p.value < 0n ? -p.value : p.value)} ₫ · ${p.units} máy`;
          return (
            <g key={p.month}>
              <title>{tip}</title>
              {/* vùng bấm lớn hơn cột */}
              <rect x={k * slot} y={0} width={slot} height={H - bottom + 4} fill="transparent" />
              {bh > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(bh, 1)}
                  rx={Math.min(4, barW / 2)}
                  className={p.value < 0n ? "text-danger" : "text-primary"}
                  fill="currentColor"
                />
              )}
              {/* nhãn cách một tháng, luôn có tháng hiện tại */}
              {(points.length - 1 - k) % 2 === 0 && (
                <text x={k * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {monthLabel(p.month)}
                </text>
              )}
            </g>
          );
        })}
        {max > 0n && peak.value > 0n && (
          <text
            x={Math.min(Math.max(points.indexOf(peak) * slot + slot / 2, 24), W - 24)}
            y={zeroY - h(peak.value) - 5}
            textAnchor="middle"
            fontSize={10}
            fill="var(--text)"
          >
            {shortVnd(peak.value)}
          </text>
        )}
      </svg>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted">Xem bảng số</summary>
        <table className="mt-1 w-full tabular-nums" aria-label={`${title} theo tháng`}>
          <tbody>
            {points.map((p) => (
              <tr key={p.month} className="border-t border-border">
                <td className="py-0.5">{monthLabel(p.month)}</td>
                <td className="py-0.5 text-right">{formatVnd(p.value)} ₫</td>
                <td className="py-0.5 text-right text-muted">{p.units} máy</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Danh sách thanh ngang (vốn theo chặng, lãi theo dòng máy…): nhãn · thanh · số. */
export function HBars({
  rows,
  label,
  testid,
}: {
  rows: readonly { key: string; label: string; value: bigint; note?: string; href?: string }[];
  label: string;
  testid: string;
}) {
  const max = rows.reduce((a, r) => (r.value > a ? r.value : -r.value > a ? -r.value : a), 0n);
  return (
    <ul className="flex flex-col gap-2" aria-label={label} data-testid={testid}>
      {rows.map((r) => {
        const pct = max === 0n ? 0 : (Number(r.value < 0n ? -r.value : r.value) / Number(max)) * 100;
        const body = (
          <>
            <span className="w-24 shrink-0 text-sm">{r.label}</span>
            <span className="relative h-3 grow rounded-full bg-[var(--bg)]" aria-hidden>
              {pct > 0 && (
                <span
                  className={`absolute inset-y-0 left-0 rounded-full ${r.value < 0n ? "bg-danger" : "bg-primary"}`}
                  style={{ width: `${Math.max(pct, 2)}%` }}
                />
              )}
            </span>
            <span className="w-28 shrink-0 text-right text-sm tabular-nums">
              {shortVnd(r.value)}
              {r.note && <span className="block text-xs text-muted">{r.note}</span>}
            </span>
          </>
        );
        return (
          <li key={r.key} aria-label={`${r.label}: ${formatVnd(r.value)} ₫${r.note ? ` · ${r.note}` : ""}`}>
            {r.href ? (
              <Link href={r.href} className="flex items-center gap-3 rounded-lg px-1 py-0.5 hover:bg-[var(--bg)]">
                {body}
              </Link>
            ) : (
              <div className="flex items-center gap-3 px-1 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
