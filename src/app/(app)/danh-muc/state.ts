import type { FieldErrors } from "@/domain/catalog";

/** Kết quả một thao tác form (Server Action → giao diện). `seq` tăng mỗi lần thành công để form tự xoá trắng. */
export interface FormState {
  ok: boolean;
  seq: number;
  message?: string;
  error?: string;
  fieldErrors?: FieldErrors;
}

export const INITIAL_STATE: FormState = { ok: false, seq: 0 };
