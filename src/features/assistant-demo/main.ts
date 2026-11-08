/**
 * Chat demo cho BẢN XEM THỬ TĨNH (GitHub Pages): gắn vào khung chat đã chụp của trang Trợ lý, vẽ tin nhắn bằng DOM thuần
 * với đúng lớp CSS của `Chat.tsx`. Dữ liệu: `window.__IPRE_DEMO__` (gói dựng lúc chụp). Không gửi gì đi đâu.
 */
import type { DemoPack } from "@/domain/assistant/demo";
import type { AssistantEvent, Card, Chip, PreviewCard, Reply, StatCard, TableCard } from "@/domain/assistant/reply";
import { DemoEngine } from "./engine";

declare global {
  interface Window {
    __IPRE_DEMO__?: DemoPack;
  }
}

type Attrs = Record<string, string | boolean | undefined | ((e: Event) => void)>;
function h(tag: string, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const STATUS_LABEL: Record<PreviewCard["status"], string> = {
  PENDING: "Chờ xác nhận",
  CONFIRMED: "Đã ghi",
  DISCARDED: "Đã huỷ",
  FAILED: "Lỗi",
  EXPIRED: "Hết hạn",
  DRAFTED: "Đã đưa vào bảng kê",
};

function boot() {
  const pack = window.__IPRE_DEMO__;
  const logEl = document.querySelector<HTMLElement>('[data-testid="chat-log"]');
  const formEl = document.querySelector<HTMLFormElement>('[data-testid="chat-form"]');
  const inputEl = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
  const sendEl = document.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
  if (!pack || !logEl || !formEl || !inputEl || !sendEl) return;
  const log: HTMLElement = logEl;
  const form: HTMLFormElement = formEl;
  const input: HTMLTextAreaElement = inputEl;
  const sendBtn: HTMLButtonElement = sendEl;
  const engine = new DemoEngine(pack);
  /** tin bot đã vẽ: [phần tử, câu trả lời] — vẽ lại thẻ phiếu khi trạng thái đổi */
  const bots: { el: HTMLElement; reply: Reply }[] = [];
  let started = false;

  // điểm cuộn cuối có chừa chỗ cho ô nhập + thanh dưới (lớp scroll-mb-* giống Chat.tsx)
  const end = h("div", { "data-chat-end": true, class: "scroll-mb-[280px] md:scroll-mb-[200px]" });
  const scroll = () => {
    log.append(end);
    end.scrollIntoView({ block: "end" });
  };
  const lastCardOf = () => {
    const m = new Map<string, HTMLElement>();
    for (const b of bots) for (const c of b.reply.cards ?? []) if (c.kind === "preview") m.set(c.actionId, b.el);
    return m;
  };

  function userBubble(text: string) {
    return h(
      "div",
      { class: "flex justify-end", "data-testid": "msg-user" },
      h("p", { class: "max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-[var(--primary)] px-4 py-2.5 text-[15px] text-[var(--primary-text)]" }, text),
    );
  }

  function link(r: NonNullable<Reply["link"]>) {
    if (r.download || r.href.startsWith("#"))
      return h(
        "a",
        {
          href: "#",
          class: "btn-primary w-fit text-sm",
          "data-testid": "bot-download",
          onclick: (e: Event) => {
            e.preventDefault();
            alert("Bản xem thử tĩnh: tải file Excel cần bản chạy thật (có máy chủ và dữ liệu thật).");
          },
        },
        `⬇ ${r.label}`,
      );
    return h("a", { href: r.href, class: "w-fit text-sm font-medium text-primary hover:underline" }, `${r.label} →`);
  }

  function chipButtons(chips: Chip[]) {
    return h(
      "div",
      { class: "flex flex-wrap gap-2", "data-chips": true },
      ...chips.map((c) => h("button", { type: "button", class: "btn-secondary !min-h-9 !px-3 !py-1.5 text-sm", onclick: () => onChip(c) }, c.label)),
    );
  }

  function stat(card: StatCard) {
    const tone = (t?: string) => (t === "bad" ? "text-danger" : t === "good" ? "text-[var(--ok)]" : t === "warn" ? "text-[var(--warn)]" : "");
    return h(
      "section",
      { class: "card p-4", "data-testid": "stat-card" },
      card.title ? h("h2", { class: "mb-2 font-semibold" }, card.title) : null,
      h(
        "div",
        { class: "grid grid-cols-2 gap-2 sm:grid-cols-3" },
        ...card.items.map((it) =>
          h(
            "div",
            { class: "rounded-2xl bg-[var(--fill)] px-3 py-2" },
            h("div", { class: "text-xs text-muted" }, it.label),
            h("div", { class: `text-[17px] font-semibold ${tone(it.tone)}` }, it.value),
            it.hint ? h("div", { class: "text-xs text-muted" }, it.hint) : null,
          ),
        ),
      ),
    );
  }

  function table(card: TableCard) {
    const num = new Set(card.numeric ?? []);
    return h(
      "section",
      { class: "card overflow-hidden", "data-testid": "table-card" },
      card.title ? h("h2", { class: "px-4 pt-3 font-semibold" }, card.title) : null,
      h(
        "div",
        { class: "overflow-x-auto" },
        h(
          "table",
          { class: "w-full text-sm" },
          h("thead", {}, h("tr", { class: "text-left text-xs text-muted" }, ...card.columns.map((c, i) => h("th", { class: `whitespace-nowrap px-3 py-2 font-medium ${num.has(i) ? "text-right" : ""}` }, c)))),
          h(
            "tbody",
            {},
            ...card.rows.map((r, k) =>
              h(
                "tr",
                { class: "border-t border-[var(--border)]" },
                ...r.map((v, i) =>
                  h(
                    "td",
                    { class: `px-3 py-1.5 ${num.has(i) ? "whitespace-nowrap text-right tabular-nums" : ""}` },
                    i === 0 && card.hrefs?.[k] ? h("a", { href: card.hrefs[k]!, class: "font-medium text-primary hover:underline" }, v) : v,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      card.more ? h("p", { class: "px-4 py-2 text-xs text-muted" }, `… và ${card.more} dòng nữa — mở trang chi tiết để xem hết`) : null,
    );
  }

  function preview(card: PreviewCard, live: boolean) {
    const status = engine.status(card.actionId);
    const pending = status === "PENDING";
    const active = pending && live;
    const editBox = h("form", { class: "mt-3 hidden gap-2" });
    const editInput = h("input", {
      class: "field flex-1",
      placeholder: "vd: giá 26tr · khách chị Hoa 0912… · ngày hôm qua · tk tiền mặt · bh 12",
      "aria-label": "Sửa phiếu",
      "data-testid": "edit-input",
    }) as HTMLInputElement;
    editBox.append(editInput, h("button", { type: "submit", class: "btn-primary" }, "Sửa"));
    editBox.addEventListener("submit", (e) => {
      e.preventDefault();
      if (editInput.value.trim()) act({ type: "EDIT", actionId: card.actionId, text: editInput.value }, `sửa ${editInput.value}`);
    });
    return h(
      "section",
      { class: `card p-4 ${active ? "" : "opacity-75"}`, "data-testid": "preview-card", "data-status": status, "aria-label": card.title },
      h(
        "div",
        { class: "mb-2 flex items-center justify-between gap-2" },
        h("h2", { class: "font-semibold" }, card.title),
        h("span", { class: "chip !font-sans", "data-testid": "preview-status" }, live ? STATUS_LABEL[status] : "Bản cũ — đã sửa bên dưới"),
      ),
      h(
        "dl",
        { class: "grid grid-cols-[minmax(96px,auto)_1fr] gap-x-3 gap-y-1 text-sm" },
        ...card.rows.flatMap(([k, v]) => [h("dt", { class: "text-muted" }, k), h("dd", { class: "break-words font-medium", "data-testid": `row-${k}` }, v)]),
      ),
      card.profit
        ? h(
            "p",
            { class: `mt-2 text-sm font-semibold ${card.profit.negative ? "text-danger" : "text-[var(--ok)]"}`, "data-testid": "preview-profit" },
            `Lãi dự kiến: ${card.profit.value}${card.profit.margin ? ` (${card.profit.margin})` : ""}${card.profit.provisional ? " · tạm tính" : ""}`,
          )
        : null,
      card.warnings.length ? h("ul", { class: "mt-2 flex flex-col gap-1 rounded-xl bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn)]" }, ...card.warnings.map((w) => h("li", {}, `⚠ ${w}`))) : null,
      active && card.blockers.length ? h("ul", { class: "mt-2 flex flex-col gap-1 text-sm text-danger", "data-testid": "preview-blockers" }, ...card.blockers.map((w) => h("li", {}, `⛔ ${w}`))) : null,
      active
        ? h(
            "div",
            { class: "mt-3 flex flex-wrap gap-2" },
            h("button", { type: "button", class: "btn-primary", disabled: card.blockers.length > 0, "data-testid": "btn-confirm", onclick: () => act({ type: "CONFIRM", actionId: card.actionId }) }, "Xác nhận ghi"),
            h(
              "button",
              {
                type: "button",
                class: "btn-secondary",
                "data-testid": "btn-edit",
                onclick: () => {
                  editBox.classList.toggle("hidden");
                  editBox.classList.toggle("flex");
                  editInput.focus();
                },
              },
              "Sửa",
            ),
            h("button", { type: "button", class: "btn-secondary", onclick: () => act({ type: "TO_BANG_KE", actionId: card.actionId }) }, "Để sau"),
            h("button", { type: "button", class: "btn-danger", "data-testid": "btn-discard", onclick: () => act({ type: "DISCARD", actionId: card.actionId }) }, "Huỷ"),
          )
        : null,
      active ? editBox : null,
    );
  }

  function cardView(c: Card, live: boolean) {
    return c.kind === "preview" ? preview(c, live) : c.kind === "stat" ? stat(c) : table(c);
  }

  function botMessage(reply: Reply, el?: HTMLElement) {
    const last = lastCardOf();
    const box = el ?? h("div", { class: "flex max-w-full flex-col gap-2 md:max-w-[92%]", "data-testid": "msg-bot" });
    box.replaceChildren(
      h("p", { class: "card w-fit max-w-full whitespace-pre-wrap break-words rounded-bl-md px-4 py-2.5 text-[15px]" }, reply.text),
      ...(reply.cards ?? []).map((c) => cardView(c, c.kind !== "preview" || last.get(c.actionId) === box || !last.has(c.actionId))),
      ...(reply.link ? [link(reply.link)] : []),
      ...(reply.chips?.length ? [chipButtons(reply.chips)] : []),
    );
    return box;
  }

  /** vẽ lại mọi tin bot (trạng thái phiếu / thẻ mới nhất đổi); chỉ tin cuối giữ nút gợi ý */
  function redraw() {
    bots.forEach((b, i) => {
      botMessage(b.reply, b.el);
      if (i < bots.length - 1) b.el.querySelector("[data-chips]")?.remove();
    });
    scroll();
  }

  function push(userText: string | null, replies: Reply[]) {
    if (!started) {
      log.replaceChildren();
      started = true;
    }
    if (userText) log.append(userBubble(userText));
    for (const r of replies) {
      const el = h("div", { class: "flex max-w-full flex-col gap-2 md:max-w-[92%]", "data-testid": "msg-bot" });
      bots.push({ el, reply: r });
      log.append(el);
    }
    redraw();
  }

  const send = (t: string) => {
    const v = t.trim();
    if (!v) return;
    input.value = "";
    sendBtn.disabled = true;
    push(v, engine.send(v));
  };
  const act = (ev: AssistantEvent, echo?: string) => push(echo ?? null, engine.event(ev));
  function onChip(c: Chip) {
    if (c.event) return act(c.event);
    if (!c.text) return;
    if (/\s$/.test(c.text)) {
      input.value = c.text;
      input.focus();
      sendBtn.disabled = false;
    } else send(c.text);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    send(input.value);
  });
  form.removeAttribute("onsubmit");
  form.onsubmit = null;
  input.addEventListener("input", () => {
    sendBtn.disabled = !input.value.trim();
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  // nút gợi ý đã chụp (thanh nhanh + lời chào)
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-chip-text]")) {
    b.disabled = false;
    b.addEventListener("click", () => onChip({ label: b.textContent ?? "", text: b.dataset.chipText }));
  }
  sendBtn.disabled = true;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
