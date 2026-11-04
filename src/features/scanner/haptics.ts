/**
 * Phản hồi khi đọc được mã: rung + tiếng bíp.
 *
 * - Android/Chrome: navigator.vibrate().
 * - iPhone (Safari, iOS 18+): Safari KHÔNG hỗ trợ navigator.vibrate. iOS rung nhẹ (Taptic) khi bật/tắt
 *   công tắc gốc <input type="checkbox" switch> — nên giữ một công tắc ẩn và "bấm" vào nhãn của nó.
 *   Máy iOS cũ hơn không có cách rung từ trang web; vẫn có tiếng bíp và hiệu ứng nháy trên màn hình.
 * - Âm thanh: Safari chỉ cho phát sau khi người dùng chạm → gọi unlockFeedback() trong sự kiện chạm
 *   (nút "Bật camera"), dùng lại một AudioContext duy nhất.
 */

let audio: AudioContext | null = null;
let switchLabel: HTMLLabelElement | null = null;

declare global {
  interface Window {
    /** Số lần đã phát phản hồi — dùng cho kiểm thử tự động. */
    __ipreHaptics?: { tick: number; success: number };
  }
}

export function unlockFeedback() {
  if (typeof window === "undefined") return;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx && !audio) audio = new Ctx();
    void audio?.resume();
  } catch {
    audio = null;
  }
  if (!switchLabel) {
    const id = "ipre-haptic-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.id = id;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    const label = document.createElement("label");
    label.htmlFor = id;
    label.setAttribute("aria-hidden", "true");
    for (const el of [input, label]) {
      el.style.cssText = "position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(el);
    }
    switchLabel = label;
  }
}

function tap() {
  try {
    if (typeof navigator.vibrate === "function" && navigator.vibrate(1) !== false) return "vibrate";
  } catch {
    /* không hỗ trợ */
  }
  switchLabel?.click();
  return "switch";
}

function beep(freq: number, ms: number, at = 0) {
  if (!audio) return;
  try {
    const t = audio.currentTime + at;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  } catch {
    /* bỏ qua */
  }
}

/** "tick": đọc thêm được một giá trị · "success": đã đọc xong một máy (serial/IMEI). */
export function haptic(kind: "tick" | "success") {
  if (typeof window === "undefined") return;
  const counter = (window.__ipreHaptics ??= { tick: 0, success: 0 });
  counter[kind]++;
  const mode = tap();
  if (kind === "success") {
    if (mode === "vibrate") navigator.vibrate([60, 70, 120]);
    else window.setTimeout(() => switchLabel?.click(), 140);
    beep(1046, 90);
    beep(1568, 140, 0.11);
  } else {
    if (mode === "vibrate") navigator.vibrate(35);
    beep(1320, 70);
  }
}
