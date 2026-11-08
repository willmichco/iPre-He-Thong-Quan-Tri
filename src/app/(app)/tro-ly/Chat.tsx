"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { AssistantEvent, Card, Chip, PreviewCard, Reply, StatCard, TableCard } from "@/domain/assistant/reply";
import type { MessageRow } from "@/server/assistant/store";
import { clearHistoryAction, eventAction, sendMessageAction, type ChatState } from "./actions";

const STATUS_LABEL: Record<PreviewCard["status"], string> = {
  PENDING: "Chờ xác nhận",
  CONFIRMED: "Đã ghi",
  DISCARDED: "Đã huỷ",
  FAILED: "Lỗi",
  EXPIRED: "Hết hạn",
  DRAFTED: "Đã đưa vào bảng kê",
};

export function Chat({ initial, quick }: { initial: MessageRow[]; quick: Chip[] }) {
  const [messages, setMessages] = useState(initial);
  // trang được dựng lại từ máy chủ (quay lại từ Bảng kê, refresh sau khi ghi): nhận lịch sử mới
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setMessages(initial);
  }
  const [sending, setSending] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sending]);

  // tự giãn ô nhập theo nội dung (dán danh sách nhiều dòng)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const apply = (s: ChatState) => {
    setMessages(s.messages);
    setError(s.error ?? null);
    setSending(null);
  };
  const send = (raw: string) => {
    const v = raw.trim();
    if (!v || isPending) return;
    setSending(v);
    setText("");
    start(async () => apply(await sendMessageAction(v)));
  };
  const fire = (ev: AssistantEvent) => {
    if (isPending) return;
    start(async () => apply(await eventAction(ev)));
  };
  const onChip = (c: Chip) => {
    if (c.event) return fire(c.event);
    if (!c.text) return;
    // mẫu câu chưa đủ (kết thúc bằng khoảng trắng) → điền vào ô nhập để gõ tiếp
    if (/\s$/.test(c.text)) {
      setText(c.text);
      inputRef.current?.focus();
    } else send(c.text);
  };

  // một phiếu có thể hiện nhiều lần (sau mỗi lần sửa) — chỉ thẻ mới nhất có nút bấm
  const lastCardOf = useMemo(() => {
    const m = new Map<string, number>();
    messages.forEach((msg) =>
      msg.reply?.cards?.forEach((c) => {
        if (c.kind === "preview") m.set(c.actionId, msg.id);
      }),
    );
    return m;
  }, [messages]);
  const lastBotId = [...messages].reverse().find((m) => m.role === "BOT")?.id;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3" aria-live="polite" data-testid="chat-log">
        {!messages.length && !sending && <Welcome quick={quick} onChip={onChip} />}
        {messages.map((m) =>
          m.role === "USER" ? (
            <UserBubble key={m.id} text={m.text} />
          ) : (
            <BotMessage
              key={m.id}
              reply={m.reply ?? { text: m.text }}
              live={(id) => lastCardOf.get(id) === m.id}
              showChips={m.id === lastBotId}
              onChip={onChip}
              onEvent={fire}
              busy={isPending}
            />
          ),
        )}
        {sending && (
          <>
            <UserBubble text={sending} />
            <div className="card w-fit px-4 py-3 text-sm text-muted" role="status">
              Đang đọc…
            </div>
          </>
        )}
        {/* chừa chỗ cho ô nhập + thanh điều hướng dưới (điện thoại) để nút của phiếu mới không bị che khi cuộn tới */}
        <div ref={endRef} data-chat-end className="scroll-mb-[280px] md:scroll-mb-[200px]" />
      </div>

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <form
        data-testid="chat-form"
        className="glass-strong sticky bottom-[calc(env(safe-area-inset-bottom)+84px)] z-30 flex flex-col gap-2 rounded-[22px] p-2 md:bottom-4"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          {quick.map((c) => (
            <button
              key={c.label}
              type="button"
              className="chip shrink-0 !font-sans !text-[13px] hover:bg-[var(--fill-strong)]"
              onClick={() => onChip(c)}
              disabled={isPending}
              data-chip-text={c.text}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Tin nhắn
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            data-testid="chat-input"
            className="field max-h-[200px] min-h-[44px] flex-1 resize-none py-2.5"
            rows={1}
            value={text}
            placeholder="Nhắn: bán…, chi…, tồn kho, doanh thu…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(text);
              }
            }}
            maxLength={4000}
            autoComplete="off"
            enterKeyHint="send"
          />
          <button type="submit" className="btn-primary shrink-0" disabled={isPending || !text.trim()} data-testid="chat-send">
            Gửi
          </button>
        </div>
        <div className="flex justify-between gap-2 px-1 text-xs text-muted">
          <span className="hidden md:inline">Enter để gửi · Shift+Enter xuống dòng (dán nhiều dòng IMEI được)</span>
          {messages.length > 0 && (
            <button
              type="button"
              className="ml-auto hover:text-[var(--text)] hover:underline"
              onClick={() => {
                if (confirm("Xoá toàn bộ lịch sử trò chuyện? Phiếu đã ghi và bảng kê nháp vẫn giữ.")) start(async () => apply(await clearHistoryAction()));
              }}
            >
              Xoá lịch sử
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function Welcome({ quick, onChip }: { quick: Chip[]; onChip: (c: Chip) => void }) {
  const samples: Chip[] = [
    { label: "bán … cho chị Lan 25tr5 ck", text: "bán " },
    { label: "chi quảng cáo 2tr hôm qua", text: "chi quảng cáo 2tr hôm qua" },
    { label: "còn mấy con pro max", text: "còn mấy con pro max" },
    { label: "Xem các câu mẫu", text: "giúp" },
  ];
  return (
    <div className="card p-5">
      <p className="font-semibold">Chào bạn 👋</p>
      <p className="mt-1 text-sm text-muted">
        Nhắn như nhắn cho người làm: máy (IMEI, Serial, vài số cuối hoặc tên dòng máy), giá (25tr5, 25.500.000), khách, SĐT, ngày (hôm qua, 5/11), kênh
        (zalo, fb), thanh toán (ck, tiền mặt, cọc, ghi nợ). Mình lập phiếu — bạn bấm Xác nhận mới ghi vào sổ.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {[...samples, ...quick.slice(0, 2)].map((c) => (
          <button key={c.label} type="button" className="btn-secondary !min-h-9 !px-3 !py-1.5 text-sm" onClick={() => onChip(c)} data-chip-text={c.text}>
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end" data-testid="msg-user">
      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-[var(--primary)] px-4 py-2.5 text-[15px] text-[var(--primary-text)]">
        {text}
      </p>
    </div>
  );
}

function BotMessage({
  reply,
  live,
  showChips,
  onChip,
  onEvent,
  busy,
}: {
  reply: Reply;
  live: (actionId: string) => boolean;
  showChips: boolean;
  onChip: (c: Chip) => void;
  onEvent: (ev: AssistantEvent) => void;
  busy: boolean;
}) {
  return (
    <div className="flex max-w-full flex-col gap-2 md:max-w-[92%]" data-testid="msg-bot">
      <p className="card w-fit max-w-full whitespace-pre-wrap break-words rounded-bl-md px-4 py-2.5 text-[15px]">{reply.text}</p>
      {reply.cards?.map((c, i) => <CardView key={i} card={c} live={c.kind === "preview" && live(c.actionId)} onEvent={onEvent} busy={busy} />)}
      {reply.link &&
        (reply.link.download || reply.link.href.startsWith("/tro-ly/xuat") ? (
          <a href={reply.link.href} className="btn-primary w-fit text-sm" download data-testid="bot-download">
            ⬇ {reply.link.label}
          </a>
        ) : (
          <Link href={reply.link.href} className="w-fit text-sm font-medium text-primary hover:underline">
            {reply.link.label} →
          </Link>
        ))}
      {showChips && reply.chips?.length ? (
        <div className="flex flex-wrap gap-2">
          {reply.chips.map((c, i) => (
            <button key={i} type="button" className="btn-secondary !min-h-9 !px-3 !py-1.5 text-sm" onClick={() => onChip(c)} disabled={busy}>
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CardView({ card, live, onEvent, busy }: { card: Card; live: boolean; onEvent: (ev: AssistantEvent) => void; busy: boolean }) {
  if (card.kind === "preview") return <Preview card={card} live={live} onEvent={onEvent} busy={busy} />;
  if (card.kind === "stat") return <Stat card={card} />;
  return <Table card={card} />;
}

function Preview({ card, live, onEvent, busy }: { card: PreviewCard; live: boolean; onEvent: (ev: AssistantEvent) => void; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState("");
  const pending = card.status === "PENDING";
  const active = pending && live;
  // thẻ cũ của cùng một phiếu (trước khi sửa): số liệu đã cũ — không hiện trạng thái / kết quả để khỏi hiểu nhầm
  const superseded = !live;
  return (
    <section className={`card p-4 ${active ? "" : "opacity-75"}`} data-testid="preview-card" data-status={card.status} aria-label={card.title}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-semibold">{card.title}</h2>
        <span
          className={`chip !font-sans ${card.status === "CONFIRMED" ? "!bg-[color-mix(in_srgb,var(--ok)_16%,transparent)] text-[var(--ok)]" : card.status === "PENDING" ? "" : "text-muted"}`}
          data-testid="preview-status"
        >
          {superseded ? "Bản cũ — đã sửa bên dưới" : STATUS_LABEL[card.status]}
        </span>
      </div>
      <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-3 gap-y-1 text-sm">
        {card.rows.map(([k, v], i) => (
          <div key={i} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="break-words font-medium" data-testid={`row-${k}`}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {card.profit && (
        <p className={`mt-2 text-sm font-semibold ${card.profit.negative ? "text-danger" : "text-[var(--ok)]"}`} data-testid="preview-profit">
          Lãi dự kiến: {card.profit.value}
          {card.profit.margin ? ` (${card.profit.margin})` : ""}
          {card.profit.provisional ? " · tạm tính" : ""}
        </p>
      )}
      {card.warnings.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 rounded-xl bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn)]">
          {card.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {active && card.blockers.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-sm text-danger" data-testid="preview-blockers">
          {card.blockers.map((w, i) => (
            <li key={i}>⛔ {w}</li>
          ))}
        </ul>
      )}
      {card.error && active && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {card.error}
        </p>
      )}
      {card.result && !superseded && (
        <Link href={card.result.href} className="mt-3 inline-block text-sm font-medium text-primary hover:underline" data-testid="preview-result">
          {card.result.label} →
        </Link>
      )}
      {active && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || card.blockers.length > 0}
              onClick={() => onEvent({ type: "CONFIRM", actionId: card.actionId })}
              data-testid="btn-confirm"
            >
              Xác nhận ghi
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing((x) => !x)} data-testid="btn-edit">
              Sửa
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onEvent({ type: "TO_BANG_KE", actionId: card.actionId })}>
              Để sau
            </button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => onEvent({ type: "DISCARD", actionId: card.actionId })} data-testid="btn-discard">
              Huỷ
            </button>
          </div>
          {editing && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!edit.trim()) return;
                onEvent({ type: "EDIT", actionId: card.actionId, text: edit });
                setEdit("");
                setEditing(false);
              }}
            >
              <input
                className="field flex-1"
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
                placeholder="vd: giá 26tr · khách chị Hoa 0912… · ngày hôm qua · tk tiền mặt · bh 12"
                aria-label="Sửa phiếu"
                autoFocus
                data-testid="edit-input"
              />
              <button type="submit" className="btn-primary" disabled={busy}>
                Sửa
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ card }: { card: StatCard }) {
  return (
    <section className="card p-4" data-testid="stat-card">
      {card.title && <h2 className="mb-2 font-semibold">{card.title}</h2>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {card.items.map((it, i) => (
          <div key={i} className="rounded-2xl bg-[var(--fill)] px-3 py-2">
            <div className="text-xs text-muted">{it.label}</div>
            <div className={`text-[17px] font-semibold ${it.tone === "bad" ? "text-danger" : it.tone === "good" ? "text-[var(--ok)]" : it.tone === "warn" ? "text-[var(--warn)]" : ""}`}>
              {it.value}
            </div>
            {it.hint && <div className="text-xs text-muted">{it.hint}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function Table({ card }: { card: TableCard }) {
  const num = new Set(card.numeric ?? []);
  return (
    <section className="card overflow-hidden" data-testid="table-card">
      {card.title && <h2 className="px-4 pt-3 font-semibold">{card.title}</h2>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              {card.columns.map((c, i) => (
                <th key={i} className={`whitespace-nowrap px-3 py-2 font-medium ${num.has(i) ? "text-right" : ""}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {card.rows.map((r, k) => (
              <tr key={k} className="border-t border-[var(--border)]">
                {r.map((v, i) => (
                  <td key={i} className={`px-3 py-1.5 ${num.has(i) ? "whitespace-nowrap text-right tabular-nums" : ""}`}>
                    {i === 0 && card.hrefs?.[k] ? (
                      <Link href={card.hrefs[k]!} className="font-medium text-primary hover:underline">
                        {v}
                      </Link>
                    ) : (
                      v
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {card.more ? <p className="px-4 py-2 text-xs text-muted">… và {card.more} dòng nữa — mở trang chi tiết để xem hết</p> : null}
    </section>
  );
}
