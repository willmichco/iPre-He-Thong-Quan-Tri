"use server";

import { costSchema } from "@/domain/costs";
import { formFields, optionalId, parse, runFormAction } from "@/server/actions/run";
import * as svc from "@/server/costs/service";
import type { FormState } from "./form-state";

const vnd = (n: bigint) => `${n < 0n ? "−" : "+"}${(n < 0n ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")} đ`;

export async function saveCostAction(prev: FormState, fd: FormData) {
  return runFormAction(prev, "chi-phi", async (db) => {
    const raw = formFields(fd);
    if (!raw.method) delete raw.method; // "theo loại chi phí" → cách chia mặc định
    const id = optionalId(fd);
    const { recalc } = await svc.saveCost(db, id, parse(costSchema, raw));
    const changes = recalc.batches.filter((b) => b.afterVnd !== b.beforeVnd).map((b) => `${b.code} ${vnd(b.afterVnd - b.beforeVnd)}`);
    return `${id ? "Đã sửa chi phí" : "Đã thêm chi phí"}${changes.length ? ` · giá vốn ${changes.join(", ")}` : ""}`;
  });
}

export async function deleteCostAction(prev: FormState, fd: FormData) {
  return runFormAction(prev, "chi-phi", async (db) => {
    const id = optionalId(fd);
    if (!id) throw new svc.CostError("NOT_FOUND", "Thiếu mã chi phí");
    await svc.deleteCost(db, id);
    return "Đã xoá chi phí";
  });
}
