import type { StreamPortMessage, StreamPortRequest } from "../shared/types";
import { selectParagraph } from "./selection";
import { createBilingualHost } from "./bilingual-host";

interface Entry { host: HTMLElement; reveal: () => void }
const paragraphs = new WeakMap<HTMLElement, Entry>();

/** Insert a separate sibling; preserve all original nodes, links and handlers. */
export function showBilingualParagraph(paragraph: HTMLElement, useContext = true): void {
  if (!paragraph.isConnected) throw new Error("Đoạn gốc không còn trên trang. Hãy chọn lại đoạn văn.");
  const existing = paragraphs.get(paragraph);
  if (existing?.host.isConnected) { existing.reveal(); return; }
  const selection = selectParagraph(paragraph);
  if (!selection.text) throw new Error("Đoạn văn không có nội dung để dịch.");
  const { host, shadow } = createBilingualHost(paragraph);
  shadow.innerHTML = `<style>
    :host{all:initial;display:block}*{box-sizing:border-box}.card{font:14px/1.8 system-ui,sans-serif;background:#f0f6f8;color:#20373d;border:1px solid #d0e2e6;border-radius:10px;padding:12px 16px;text-align:left}header{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:6px}nav{display:flex;gap:4px}button{font:11px system-ui,sans-serif;border:0;border-radius:5px;background:transparent;color:#355962;cursor:pointer;padding:5px 7px}button:hover{background:#deebee}button:focus-visible{outline:2px solid #447f8e;outline-offset:2px}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}small{color:#65787d;font-size:10px}button:disabled{opacity:.5;cursor:not-allowed}.error{color:#a1332c}
    </style><section class="card" aria-label="Bản dịch song ngữ"><header><nav><button data-action="copy" disabled>Sao chép</button><button data-action="hide" aria-expanded="true">Ẩn</button><button data-action="remove" aria-label="Xóa bản dịch song ngữ">×</button></nav></header><div class="body"><p class="translation">Đang dịch đoạn văn…</p><small role="status">Đang xử lý</small><button data-action="retry" hidden>Thử lại</button></div></section>`;
  const body = shadow.querySelector<HTMLElement>(".body")!;
  const text = shadow.querySelector<HTMLElement>(".translation")!;
  const status = shadow.querySelector<HTMLElement>("small")!;
  const hide = shadow.querySelector<HTMLButtonElement>('[data-action="hide"]')!;
  const copy = shadow.querySelector<HTMLButtonElement>('[data-action="copy"]')!;
  const retry = shadow.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
  let activePort: chrome.runtime.Port | null = null;
  let translation = "";
  let copyTimer: number | undefined;
  function reveal() { body.hidden = false; hide.textContent = "Ẩn"; hide.setAttribute("aria-expanded", "true"); }
  function stop() { const port = activePort; activePort = null; port?.disconnect(); }
  function fail(error: string) { status.textContent = error; status.className = "error"; retry.hidden = false; }
  function start() {
    stop(); translation = ""; copy.disabled = true; retry.hidden = true; status.className = ""; status.textContent = "Đang dịch…"; text.textContent = "Đang dịch đoạn văn…";
    try {
      const port = chrome.runtime.connect({ name: "translation-stream" }); activePort = port;
      port.onMessage.addListener((message: StreamPortMessage) => {
        if (activePort !== port) return;
        if (!host.isConnected) { stop(); return; }
        if (message.type === "STREAM_CHUNK") { translation = message.translation; text.textContent = translation; copy.disabled = !translation; }
        if (message.type === "STREAM_DONE") {
          translation = message.result.translation; text.textContent = translation; copy.disabled = !translation;
          activePort = null; port.disconnect(); status.textContent = message.cached ? "Đã dịch · Dùng lại bản đã lưu" : "Đã dịch · Đoạn gốc được giữ nguyên";
        }
        if (message.type === "STREAM_ERROR") { activePort = null; port.disconnect(); fail(message.error); }
      });
      port.onDisconnect.addListener(() => { if (activePort === port) { activePort = null; fail("Kết nối bị gián đoạn. Vui lòng thử lại."); } });
      port.postMessage({ type: "TRANSLATE_STREAM", text: selection.text, context: useContext ? selection.context : undefined, translationMode: "quick" } satisfies StreamPortRequest);
    } catch { stop(); fail("Không gửi được yêu cầu. Hãy tải lại trang hoặc thử lại."); }
  }
  hide.addEventListener("click", () => { body.hidden = !body.hidden; hide.textContent = body.hidden ? "Hiện" : "Ẩn"; hide.setAttribute("aria-expanded", String(!body.hidden)); });
  retry.addEventListener("click", start);
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(translation); copy.textContent = "Đã sao chép"; window.clearTimeout(copyTimer); copyTimer = window.setTimeout(() => { copy.textContent = "Sao chép"; }, 1500); }
    catch { status.textContent = "Không sao chép được. Hãy chọn bản dịch và sao chép trực tiếp."; }
  });
  shadow.querySelector('[data-action="remove"]')!.addEventListener("click", () => { stop(); window.clearTimeout(copyTimer); paragraphs.delete(paragraph); host.remove(); });
  // These actions must not open another selection launcher or dismiss the overlay.
  for (const event of ["pointerdown", "pointerup", "mouseup"]) host.addEventListener(event, event => event.stopPropagation());
  paragraph.after(host);
  paragraphs.set(paragraph, { host, reveal });
  start();
}
