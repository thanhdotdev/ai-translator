import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, inline, offset, shift } from "@floating-ui/dom";
import { Languages, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { StreamPortMessage, StreamPortRequest } from "../shared/types";

// A separate stream keeps word lookups from replacing the paragraph translation.
export function SourceLookup({ text, context, portal }: { text: string; context?: string; portal: HTMLElement }) {
  const source = useRef<HTMLParagraphElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const port = useRef<chrome.runtime.Port | null>(null);
  const [lookup, setLookup] = useState<{ text: string; range: Range } | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function cancel() { const current = port.current; port.current = null; current?.disconnect(); }
  function dismiss() { cancel(); setLookup(null); setBusy(false); }
  function translate(selected: string) {
    cancel(); setResult(""); setError(""); setBusy(true);
    try {
      const current = chrome.runtime.connect({ name: "translation-stream" });
      port.current = current;
      current.onMessage.addListener((message: StreamPortMessage) => {
        if (port.current !== current) return;
        if (message.type === "STREAM_CHUNK") setResult(message.translation);
        if (message.type === "STREAM_DONE") {
          setResult(message.result.translation); setBusy(false); cancel();
        }
        if (message.type === "STREAM_ERROR") { setError(message.error); setBusy(false); cancel(); }
      });
      current.onDisconnect.addListener(() => {
        if (port.current !== current) return;
        port.current = null; setBusy(false); setError("Kết nối bị ngắt. Bấm thử lại để dịch.");
      });
      // A one-word original still needs its page context when looked up again.
      const surrounding = context || text;
      const start = Math.max(0, surrounding.indexOf(selected) - 900);
      current.postMessage({ type: "TRANSLATE_STREAM", text: selected, context: surrounding.slice(start, start + 2400), translationMode: "quick" } satisfies StreamPortRequest);
    } catch { cancel(); setBusy(false); setError("Chưa thể dịch. Hãy tải lại trang rồi thử lại."); }
  }
  function readSelected() {
    const element = source.current;
    if (!element) return;
    const root = element.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
    const selection = root.getSelection?.() ?? window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
    const selected = selection.toString().trim();
    if (!selected || selected.length > 300) { dismiss(); return; }
    if (lookup?.text === selected) return;
    setLookup({ text: selected, range: range.cloneRange() }); translate(selected);
  }
  useEffect(() => () => { const current = port.current; port.current = null; current?.disconnect(); }, []);
  useEffect(() => {
    if (!lookup) return;
    const onOutside = (event: PointerEvent) => {
      if (!event.composedPath().includes(popup.current!) && !event.composedPath().includes(source.current!)) dismiss();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); dismiss(); }
    };
    window.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("keydown", onEscape, true);
    return () => { window.removeEventListener("pointerdown", onOutside, true); window.removeEventListener("keydown", onEscape, true); };
  }, [lookup]);
  useEffect(() => {
    const element = popup.current;
    if (!lookup || !element) return;
    let disposed = false;
    const anchor = { contextElement: source.current!, getBoundingClientRect: () => lookup.range.getBoundingClientRect(), getClientRects: () => lookup.range.getClientRects() };
    const update = () => {
      void computePosition(anchor, element, { strategy: "fixed", placement: "bottom-start", middleware: [inline(), offset(7), flip(), shift({ padding: 12 })] }).then(({ x, y }) => {
        if (!disposed) Object.assign(element.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      });
    };
    const cleanup = autoUpdate(anchor, element, update);
    return () => { disposed = true; cleanup(); };
  }, [lookup]);
  return <>
    <p ref={source} tabIndex={0} onMouseUp={readSelected} onKeyUp={event => { if (event.key === "Shift" || event.key.startsWith("Arrow")) readSelected(); }} title="Bôi đen từ hoặc cụm từ để dịch nhanh">{text}</p>
    {lookup && createPortal(<div ref={popup} className="avt-source-lookup" role="region" aria-label="Dịch từ hoặc cụm từ" onPointerDown={event => event.stopPropagation()}>
      <div className="avt-lookup-heading"><Languages size={14}/><strong>{lookup.text}</strong><button type="button" aria-label="Đóng dịch cụm từ" title="Đóng dịch cụm từ" onClick={dismiss}><X size={14}/></button></div>
      <div className="avt-lookup-result" aria-live="polite">{result || (busy ? <span role="status"><LoaderCircle size={14} className="avt-spin"/> Đang dịch…</span> : null)}{error && <p role="alert">{error}</p>}</div>
      {error && <button type="button" className="avt-lookup-retry" onClick={() => translate(lookup.text)}><RotateCcw size={13}/>Thử lại</button>}
    </div>, portal)}
  </>;
}
