/** Biểu trưng iPre: ô bo tròn chuyển sắc, bốn góc khung quét ôm chữ "i". Không dùng id SVG → đặt nhiều chỗ không trùng. */
export function BrandMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-[30%] bg-gradient-to-br from-[#3d8bff] via-[#4f6bff] to-[#8a5cff] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_6px_16px_-6px_rgba(79,107,255,0.7)] ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-[62%] w-[62%]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 8V6a2.5 2.5 0 0 1 2.5-2.5h2M16 3.5h2A2.5 2.5 0 0 1 20.5 6v2M20.5 16v2a2.5 2.5 0 0 1-2.5 2.5h-2M8 20.5H6A2.5 2.5 0 0 1 3.5 18v-2" opacity={0.75} />
        <path d="M12 11v5.5" strokeWidth={2.4} />
        <circle cx="12" cy="7.6" r="1.35" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
