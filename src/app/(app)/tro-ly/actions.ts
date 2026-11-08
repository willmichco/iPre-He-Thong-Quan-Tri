"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { AssistantEvent } from "@/domain/assistant/reply";
import { BangKeError, discardBangKe, saveBangKe } from "@/server/assistant/bang-ke";
import { todayVn } from "@/server/assistant/context";
import { handleEvent, handleMessage, promoteBangKe } from "@/server/assistant/handle";
import { clearConversation, getOrCreateConversation, listMessages, type MessageRow } from "@/server/assistant/store";
import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";

export interface ChatState {
  messages: MessageRow[];
  error?: string;
}

/** Mỗi thao tác: kiểm tra phiên → kết nối → hội thoại của chủ hàng. */
async function session() {
  await requireOwner();
  const db = getSql();
  if (!db) throw new Error("Chưa kết nối cơ sở dữ liệu");
  const conv = await getOrCreateConversation(db);
  return { db, ctx: { db, conversationId: conv.id, today: todayVn() } };
}

async function run(fn: (s: Awaited<ReturnType<typeof session>>) => Promise<unknown>): Promise<ChatState> {
  const s = await session();
  try {
    await fn(s);
  } catch (e) {
    console.error("[tro-ly]", e instanceof Error ? e.name : "lỗi");
    return { messages: await listMessages(s.db, s.ctx.conversationId), error: "Lỗi hệ thống — thử lại." };
  }
  // trang khác (Kho, Bán hàng, Tổng quan…) đọc lại số liệu mới khi mở
  refresh();
  return { messages: await listMessages(s.db, s.ctx.conversationId) };
}

export async function sendMessageAction(text: string): Promise<ChatState> {
  const t = String(text ?? "").slice(0, 4000);
  return run((s) => handleMessage(s.ctx, t));
}

const EVENT_TYPES = new Set(["CONFIRM", "DISCARD", "TO_BANG_KE", "EDIT", "CHOOSE"]);
export async function eventAction(ev: AssistantEvent): Promise<ChatState> {
  // dữ liệu từ trình duyệt: chỉ nhận đúng dạng sự kiện, phiếu tra lại trong CSDL
  if (!ev || !EVENT_TYPES.has(ev.type) || typeof ev.actionId !== "string") return run(async () => {});
  const clean: AssistantEvent =
    ev.type === "EDIT"
      ? { type: "EDIT", actionId: ev.actionId, text: String(ev.text ?? "").slice(0, 500) }
      : ev.type === "CHOOSE"
        ? { type: "CHOOSE", actionId: ev.actionId, index: Math.trunc(Number(ev.index)) || 0 }
        : { type: ev.type, actionId: ev.actionId };
  return run((s) => handleEvent(s.ctx, clean));
}

export async function clearHistoryAction(): Promise<ChatState> {
  return run((s) => clearConversation(s.db, s.ctx.conversationId));
}

// ---- Bảng kê nháp ----------------------------------------------------------------------------------------

const FIELDS = ["kind", "occurredOn", "modelText", "code", "priceText", "customerText", "customerPhone", "channel", "payment", "refText", "note"] as const;

export async function saveBangKeAction(fd: FormData) {
  const { db } = await session();
  const id = String(fd.get("id") ?? "");
  const intent = String(fd.get("intent") ?? "save");
  if (intent === "discard") {
    await discardBangKe(db, [id]);
    refresh();
    return;
  }
  const values = Object.fromEntries(FIELDS.map((f) => [f, String(fd.get(f) ?? "")]));
  let error: string | null = null;
  try {
    await saveBangKe(db, id, values);
  } catch (e) {
    if (!(e instanceof BangKeError)) throw e;
    error = e.message;
  }
  if (error) redirect(`/tro-ly/bang-ke?loi=${encodeURIComponent(error)}#d-${id}`);
  if (intent === "promote") {
    const s = await session();
    await promoteBangKe(s.ctx, id);
    redirect("/tro-ly");
  }
  refresh();
}
