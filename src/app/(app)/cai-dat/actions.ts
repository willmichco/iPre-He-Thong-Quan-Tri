"use server";

import { SETTINGS } from "@/domain/settings";
import { runFormAction } from "@/server/actions/run";
import { saveSettings } from "@/server/settings/service";
import type { FormState } from "../_components/form-state";

export async function saveSettingsAction(prev: FormState, fd: FormData) {
  return runFormAction(prev, "cai-dat", async (db) => {
    const input = Object.fromEntries(SETTINGS.flatMap((s) => (fd.has(s.key) ? [[s.key, String(fd.get(s.key))]] : [])));
    const n = await saveSettings(db, input);
    return n ? `Đã lưu ${n} cài đặt` : "Không có gì thay đổi";
  });
}
