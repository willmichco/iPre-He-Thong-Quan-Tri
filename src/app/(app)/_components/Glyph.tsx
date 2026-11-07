/**
 * Biểu tượng nét mảnh cho nội dung trang (SVG tự vẽ, 24×24, theo màu chữ) — thay emoji (🤖 ⚠ ✓ ▌▌▌) để hiển thị
 * đều nhau trên mọi máy, đổi màu theo chủ đề sáng / tối. Luôn aria-hidden: nghĩa đã nằm ở chữ đi kèm.
 */
const PATHS = {
  bot: (
    <>
      <rect x="4.5" y="8" width="15" height="11.5" rx="3.5" />
      <path d="M12 4.8V8M9.4 13.2h.01M14.6 13.2h.01M9.5 16.3h5M2.5 12.5v2.5M21.5 12.5v2.5" />
      <circle cx="12" cy="3.9" r="1" />
    </>
  ),
  warn: (
    <>
      <path d="M10.3 4.2 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 16.8h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.8h.01" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.4 12.3 2.5 2.5 4.7-5.1" />
    </>
  ),
  missing: <circle cx="12" cy="12" r="8" strokeDasharray="2.6 2.9" />,
  barcode: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M8 9v6M11 9v6M14 9v6M17 9v6" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6" />
      <path d="M4 4.5v4.1h4.1M12 8v4.2l2.8 1.8" />
    </>
  ),
  refresh: <path d="M19.5 10.5a7.6 7.6 0 0 0-13.7-3.4L4.5 8.8M4.5 4.5v4.3h4.3M4.5 13.5a7.6 7.6 0 0 0 13.7 3.4l1.3-1.7M19.5 19.5v-4.3h-4.3" />,
  tag: (
    <>
      <path d="M3.8 12.4V5.3a1.5 1.5 0 0 1 1.5-1.5h7.1a1.5 1.5 0 0 1 1.06.44l7.1 7.1a1.5 1.5 0 0 1 0 2.12l-7.1 7.1a1.5 1.5 0 0 1-2.12 0l-7.1-7.1a1.5 1.5 0 0 1-.44-1.06Z" />
      <circle cx="8.6" cy="8.6" r="1.4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  external: <path d="M14 4.5h5.5V10M19.5 4.5 11 13M17.5 14v3.8a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2H10" />,
  box: (
    <>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="m20.5 15.5-4.6-4.6a1.5 1.5 0 0 0-2.1 0L6 18.7" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  trash: <path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 7.6-1.7" />
    </>
  ),
  login: <path d="M10 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M14 8l4 4-4 4M18 12H9" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  arrow: <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />,
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  swap: <path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" />,
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />,
  doc: (
    <>
      <path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z" />
      <path d="M14 3.5V8h4.5M9 13h6M9 16.5h4" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13.5 6.3 6a2 2 0 0 1 1.9-1.5h7.6A2 2 0 0 1 17.7 6l2.3 7.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
      <path d="M4 13.5h4.5l1 2h5l1-2H20" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  up: <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" />,
  down: <path d="M12 5v13M6.5 12.5 12 18l5.5-5.5" />,
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 18, className }: { name: GlyphName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
