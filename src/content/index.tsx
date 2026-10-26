import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge, Button, Card, Flex, IconButton, Skeleton, Tabs, Text, Theme } from "@radix-ui/themes";
import { autoUpdate, computePosition, flip, inline, offset, shift } from "@floating-ui/dom";
import { FileText, BookOpen, Check, ChevronDown, Copy, Languages, LoaderCircle, Pin, RotateCcw, Rows2, Sparkles, Square, Info, X } from "lucide-react";
import type { AppState, RuntimeMessage, StreamPortMessage, StreamPortRequest, TranslationMode, TranslationResult, TranslateResponse } from "../shared/types";
import themeCss from "@radix-ui/themes/styles.css?inline";
import contentCss from "./style.css?inline";

import { Pronunciation } from "./pronunciation";
import { SourceLookup } from "./source-lookup";
import { nearbyContext, paragraphForRange, type SelectedText } from "./selection";
import { showBilingualParagraph } from "./bilingual";
import { watchSelectionEvents } from "./selection-events";
import { enablePanelDrag, clampPanelPosition, type PanelPosition } from "./panel-drag";
type Phase = "idle" | "loading" | "streaming" | "explaining" | "done" | "stopped" | "error";
interface View {
  selection: SelectedText | null;
  phase: Phase;
  result: TranslationResult | null;
  translation: string;
  error: string;
  minimized: boolean;
  showSource: boolean;
  pinned: boolean;
  copied: boolean;
  tab: string;
  cached: boolean;
  historyId?: string;
  detailPhase?: "idle" | "loading" | "done" | "error";
  detailError?: string;
  useContext: boolean;
}
let view: View = { selection: null, phase: "idle", result: null, translation: "", error: "", minimized: false, showSource: false, pinned: false, copied: false, tab: "translation", cached: false, useContext: true };
let appState: AppState | null = null;
let activePort: chrome.runtime.Port | null = null;
let selectionVersion = 0;
let selectionTimer: number | undefined;
let copyTimer: number | undefined;
let detailsInFlight: string | null = null;
let lastMode: TranslationMode | undefined;
let updateView: ((next: View) => void) | undefined;

// Isolate the component library from the host website's styles and event handlers.
const host = document.createElement("div");
host.id = "ai-vietnamese-translator-root";
document.getElementById(host.id)?.dispatchEvent(new Event("avt:dispose"));
document.getElementById(host.id)?.remove();
document.getElementById("ai-vietnamese-translator-style")?.remove();
host.style.setProperty("all", "initial", "important");
host.style.setProperty("position", "fixed", "important");
host.style.setProperty("z-index", "2147483647", "important");
host.style.setProperty("top", "0", "important");
host.style.setProperty("left", "0", "important");
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = `${themeCss}\n${contentCss}`;
shadow.appendChild(style);
const mount = document.createElement("div");
shadow.appendChild(mount);
document.documentElement.appendChild(host);

function patch(next: Partial<View>) { view = { ...view, ...next }; updateView?.(view); }
function cancelPort() {
  const port = activePort; activePort = null; port?.disconnect();
}
function close() {
  selectionVersion++; window.clearTimeout(selectionTimer); window.clearTimeout(copyTimer);
  cancelPort(); patch({ selection: null, result: null, translation: "", phase: "idle", pinned: false, copied: false });
}
function isInside(event: Event) { return event.composedPath().includes(host) || event.composedPath().some(node => node instanceof HTMLElement && node.dataset.avtBilingual === "true"); }

function readSelection(): SelectedText | null {
  const active = document.activeElement;
  if (active === host) return null;
  if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && ["text", "search", "url", "email", "tel"].includes(active.type))) {
    const start = active.selectionStart, end = active.selectionEnd;
    const text = start !== null && end !== null ? active.value.slice(start, end).trim() : "";
    if (text.length >= 1) return { text, context: active.value.slice(Math.max(0, start! - 700), end! + 700).slice(0, 2400), anchor: { getBoundingClientRect: () => active.getBoundingClientRect(), contextElement: active } };
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return null;
  if (shadow.contains(selection.anchorNode) || host.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const contextElement = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement ?? undefined;
  if (contextElement?.closest('[data-avt-bilingual]')) return null;
  const paragraph = paragraphForRange(range);
  const text = selection.toString().trim();
  return { text, paragraph, context: nearbyContext(paragraph, text), anchor: { getBoundingClientRect: () => range.getBoundingClientRect(), getClientRects: () => range.getClientRects(), contextElement } };
}

function scheduleSelection() {
  const version = ++selectionVersion;
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => {
    if (view.pinned || activePort) return;
    const selection = readSelection();
    if (!selection) { if (view.phase === "idle") patch({ selection: null }); return; }
    if (view.selection?.text === selection.text) return;
    if (version !== selectionVersion || view.pinned || activePort) return;
    if (appState?.preferences.showFloatingButton === false) return;
    patch({ selection, phase: "idle", result: null, translation: "", error: "", minimized: false, copied: false, tab: "translation", cached: false, useContext: true, showSource: false, historyId: undefined, detailPhase: "idle", detailError: "" });
  }, 90);
}

const stopWatchingSelection = watchSelectionEvents({
  isInside,
  onSelect: scheduleSelection,
  onOutsidePointer: () => { if (view.selection && !view.pinned) close(); }
});
function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape" && view.selection) { event.stopPropagation(); close(); }
}
document.addEventListener("keydown", onKeyDown, true);
// Pointer actions in our UI must not trigger the website's selection toolbar.
host.addEventListener("pointerup", event => event.stopPropagation());
host.addEventListener("mouseup", event => event.stopPropagation());

function fallbackSelection(text: string): SelectedText {
  return { text, anchor: { getBoundingClientRect: () => new DOMRect(Math.max(12, window.innerWidth - 460), 20, 1, 1) } };
}
function onRuntimeMessage(message: RuntimeMessage) {
  if (message.type === "COMMAND_TRANSLATE_SELECTION" || message.type === "SHOW_TRANSLATION_FOR_TEXT") {
    const selected = readSelection();
    const selection = message.type === "SHOW_TRANSLATION_FOR_TEXT" ? { ...(selected || fallbackSelection(message.text)), text: message.text } : selected;
    if (!selection) return;
    selectionVersion++; patch({ selection, pinned: false, minimized: false, useContext: true }); void translate();
  }
  if (message.type === "COMMAND_TOGGLE_RESULT") {
    if (view.selection) close(); else { const selection = readSelection(); if (selection) patch({ selection, phase: "idle" }); }
  }
  if (message.type === "COPY_LAST_TRANSLATION" && view.result) void copyTranslation();
}
chrome.runtime.onMessage.addListener(onRuntimeMessage);

async function translate(mode?: TranslationMode) {
  if (!view.selection) return;
  selectionVersion++; cancelPort(); window.clearTimeout(copyTimer); lastMode = mode;
  patch({ phase: "loading", result: null, translation: "", error: "", minimized: false, copied: false, tab: "translation", cached: false, historyId: undefined, detailPhase: "idle", detailError: "" });
  try {
    const port = chrome.runtime.connect({ name: "translation-stream" }); activePort = port;
    port.onMessage.addListener((message: StreamPortMessage) => {
      if (activePort !== port) return;
      if (message.type === "STREAM_CHUNK") patch({ phase: "streaming", translation: message.translation });
      if (message.type === "STREAM_EXPLANATION_START") patch({ phase: "explaining", translation: message.translation });
      if (message.type === "STREAM_DONE") {
        activePort = null; port.disconnect();
        patch({ phase: "done", result: message.result, translation: message.result.translation, cached: Boolean(message.cached), historyId: message.historyId });
        if (view.tab !== "translation") void loadDetails();
        void refreshState();
      }
      if (message.type === "STREAM_ERROR") { activePort = null; port.disconnect(); patch({ phase: "error", error: message.error }); }
    });
    port.onDisconnect.addListener(() => {
      if (activePort !== port) return;
      activePort = null;
      patch({ phase: "error", error: "Kết nối bị gián đoạn. Bạn có thể thử dịch lại." });
    });
    port.postMessage({ type: "TRANSLATE_STREAM", text: view.selection.text, translationMode: mode, context: view.useContext ? view.selection.context : undefined } satisfies StreamPortRequest);
  } catch (error) {
    cancelPort();
    const message = error instanceof Error ? error.message : String(error);
    patch({ phase: "error", error: message.includes("Extension context invalidated") ? "Tiện ích vừa được cập nhật. Tải lại trang này để tiếp tục dịch." : `Không thể dịch: ${message}` });
  }
}
function selectTab(tab: string) {
  patch({ tab });
  if (tab !== "translation") void loadDetails();
}
async function loadDetails() {
  const historyId = view.historyId;
  const selection = view.selection;
  if (!historyId || !view.result || view.result.detailsLoaded !== false || detailsInFlight === historyId) return;
  detailsInFlight = historyId;
  patch({ detailPhase: "loading", detailError: "" });
  try {
    const response = await chrome.runtime.sendMessage({ type: "EXPLAIN_TRANSLATION", historyId } satisfies RuntimeMessage) as TranslateResponse;
    if (view.historyId !== historyId || view.selection !== selection) return;
    if (!response.ok || !response.result) throw new Error(response.error || "Không lấy được giải thích.");
    patch({ result: response.result, detailPhase: "done" });
  } catch (error) {
    if (view.historyId === historyId && view.selection === selection) patch({ detailPhase: "error", detailError: error instanceof Error ? error.message : "Không lấy được giải thích. Vui lòng thử lại." });
  } finally { if (detailsInFlight === historyId) detailsInFlight = null; }
}
function translateParagraph() {
  const paragraph = view.selection?.paragraph;
  if (!paragraph) return;
  try { showBilingualParagraph(paragraph, view.useContext); close(); }
  catch (error) { patch({ error: error instanceof Error ? error.message : "Không chèn được bản dịch dưới đoạn này." }); }
}

async function refreshState() {
  try { appState = await chrome.runtime.sendMessage({ type: "GET_STATE" } satisfies RuntimeMessage) as AppState; if (appState.preferences?.showFloatingButton === false && view.phase === "idle") close(); else updateView?.({ ...view }); } catch { /* Optional metadata. */ }
}
async function copyTranslation() {
  const text = view.translation; if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (view.translation !== text) return;
    patch({ copied: true }); window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => patch({ copied: false }), 1600);
  } catch { patch({ error: "Không thể sao chép. Hãy chọn văn bản và sao chép trực tiếp." }); }
}

function TranslationOverlay() {
  const [state, setState] = useState(view);
  const [showContextPreview, setShowContextPreview] = useState(false);
  useLayoutEffect(() => { setShowContextPreview(false); }, [state.selection]);
  const floating = useRef<HTMLDivElement>(null);
  const manualPosition = useRef<PanelPosition | null>(null);
  useLayoutEffect(() => { manualPosition.current = null; }, [state.selection]);
  useLayoutEffect(() => { updateView = setState; setState(view); return () => { updateView = undefined; }; }, []);
  const launcher = state.phase === "idle";
  useLayoutEffect(() => {
    const element = floating.current;
    if (!state.selection || !element) return;
    let disposed = false;
    element.style.visibility = "hidden";
    const position = () => {
      if (manualPosition.current && !launcher) {
        const next = clampPanelPosition(manualPosition.current, element.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
        manualPosition.current = next;
        Object.assign(element.style, { left: `${next.x}px`, top: `${next.y}px`, visibility: "visible" });
        return;
      }
      void computePosition(state.selection!.anchor, element, {
        strategy: "fixed", placement: "bottom-start",
        middleware: launcher
          ? [inline(), offset(10), flip({ padding: 12 }), shift({ padding: 12, crossAxis: true })]
          : [offset(10), flip({ padding: 12, fallbackStrategy: "initialPlacement" }), shift({ padding: 12, crossAxis: true })]
      }).then(({ x, y }) => {
        if (disposed || manualPosition.current) return;
        // Keep the top/left anchor when content, tabs or toolbar state changes.
        // Only viewport bounds or an explicit drag may adjust it afterwards.
        if (!launcher) manualPosition.current = { x, y };
        Object.assign(element.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      }).catch(() => {
        if (!disposed && !manualPosition.current) { if (!launcher) manualPosition.current = { x: 12, y: 12 }; Object.assign(element.style, { left: "12px", top: "12px", visibility: "visible" }); }
      });
    };
    const cleanup = autoUpdate(state.selection.anchor, element, position);
    return () => { disposed = true; cleanup(); };
  }, [state.selection, launcher, state.minimized]);

  useLayoutEffect(() => {
    const panel = floating.current;
    const handle = panel?.querySelector<HTMLElement>(".avt-header");
    if (!panel || !handle || launcher) return;
    return enablePanelDrag(handle, panel, position => { manualPosition.current = position; });
  }, [launcher, state.selection]);

  if (!state.selection) return null;
  const busy = ["loading", "streaming", "explaining"].includes(state.phase);
  const provider = appState?.providers.find(item => item.id === appState?.activeProviderId);
  const result = state.result;
  const usage = provider ? appState?.usageCache[provider.id] : undefined;
  const quotaLabel = usage ? usage.error ? "Hạn mức chưa cập nhật" : typeof usage.percent === "number" ? `Đã dùng ${Math.round(usage.percent)}%` : typeof usage.usage === "number" ? `Đã dùng ${usage.usage}${typeof usage.limit === "number" ? ` / ${usage.limit}` : ""}` : "" : "";
  return <Theme appearance="light" accentColor="cyan" grayColor="slate" radius="large" scaling="100%">
    <div ref={floating} className={launcher ? "avt-launcher-position" : "avt-panel-position"}>
      {launcher ? <div className="avt-launcher" data-context-preview={showContextPreview && !!state.selection.context} role="toolbar" aria-label="Dịch văn bản đã chọn" onPointerDown={event => event.preventDefault()}>
        <IconButton size="2" aria-label="Dịch nhanh" title="Dịch nhanh" onClick={() => void translate("quick")}><Languages size={17}/></IconButton>
        {state.selection.paragraph && <IconButton size="2" variant="soft" aria-label="Dịch đoạn song ngữ" onClick={translateParagraph} title="Dịch đoạn song ngữ"><Rows2 size={16}/></IconButton>}
        {state.selection.context && <IconButton size="1" variant={state.useContext ? "soft" : "ghost"} aria-label={state.useContext ? "Ngữ cảnh: đang bật" : "Ngữ cảnh: đang tắt"} aria-pressed={state.useContext} title={state.useContext ? "Đang bật ngữ cảnh · Bấm để tắt và xem chi tiết" : "Đang tắt ngữ cảnh · Bấm để bật và xem chi tiết"} onClick={() => { patch({ useContext: !state.useContext }); setShowContextPreview(true); }}><BookOpen size={14}/></IconButton>}
        <IconButton size="1" variant="ghost" color="gray" aria-label="Ẩn nút dịch" title="Ẩn nút dịch (Esc)" onClick={close}><X size={14}/></IconButton>
        {showContextPreview && state.selection.context && <div className="avt-context-preview" role="status">
          <div className="avt-context-title"><strong>{state.useContext ? "Đang bật ngữ cảnh" : "Đang tắt ngữ cảnh"}</strong><button type="button" aria-label="Ẩn chi tiết ngữ cảnh" title="Ẩn chi tiết ngữ cảnh" onClick={() => setShowContextPreview(false)}><X size={12}/></button></div>
          {state.useContext ? <><span>Đoạn xung quanh sẽ gửi kèm:</span><p>{state.selection.context}</p></> : <span>Chỉ dịch phần bôi đen, không gửi đoạn xung quanh.</span>}
          <small>Áp dụng khi nhấn dịch. Câu rõ nghĩa có thể cho cùng bản dịch.</small>
        </div>}
      </div> : <Card className={`avt-panel${state.minimized ? " avt-panel-minimized" : ""}${state.showSource ? " avt-panel-source" : ""}`} size="1" role="region" aria-label="Bảng dịch AI">
        <header className="avt-header" tabIndex={0} aria-label="Di chuyển bảng dịch" title="Kéo để di chuyển · Dùng phím mũi tên khi thanh này được chọn">
          <span className="avt-brand" title={busy ? "Đang dịch…" : "Dịch sang tiếng Việt"}>{busy ? <LoaderCircle size={17} className="avt-spin"/> : <Languages size={17}/>}</span>
          <Flex gap="1" className="avt-header-actions"><IconButton variant="ghost" data-active={state.showSource} color="gray" size="1" aria-label={state.showSource ? "Ẩn văn bản gốc" : "Hiện văn bản gốc"} aria-expanded={state.showSource} title={state.showSource ? "Ẩn văn bản gốc" : "Hiện văn bản gốc"} onClick={() => patch({ showSource: !state.showSource })}><FileText size={15}/></IconButton><IconButton variant="ghost" data-active={state.pinned} color={state.pinned ? "cyan" : "gray"} size="1" aria-label={state.pinned ? "Bỏ ghim bảng dịch" : "Ghim bảng dịch"} aria-pressed={state.pinned} title={state.pinned ? "Đang ghim · Bấm để bỏ ghim" : "Ghim: giữ popup khi bấm ra ngoài hoặc chọn đoạn khác"} onClick={() => patch({ pinned: !state.pinned })}><Pin size={15}/></IconButton>
            <IconButton variant="ghost" color="gray" size="1" aria-label={state.minimized ? "Mở rộng bảng dịch" : "Thu gọn bảng dịch"} aria-expanded={!state.minimized} title="Thu gọn / mở rộng" onClick={() => patch({ minimized: !state.minimized })}><ChevronDown size={17} className={state.minimized ? "avt-rotate" : ""}/></IconButton>
            <IconButton variant="ghost" color="gray" size="1" aria-label="Đóng bảng dịch" title="Đóng (Esc)" onClick={close}><X size={17}/></IconButton></Flex>
        </header>
        {!state.minimized && <>
          {state.showSource && <div className="avt-source"><div className="avt-label"><div className="avt-source-title">BẢN GỐC <Pronunciation key={`pronunciation-${state.selection.text}`} text={state.selection.text} portal={mount}/></div><span>{state.useContext && state.selection.context ? "Có ngữ cảnh · " : ""}{state.selection.text.length.toLocaleString("vi-VN")} ký tự</span></div><SourceLookup key={state.selection.text} text={state.selection.text} context={state.useContext ? state.selection.context : undefined} portal={mount}/></div>}
          <Tabs.Root className="avt-tab-root" value={state.tab} onValueChange={selectTab}>
            <Tabs.List aria-label="Nội dung bản dịch" className="avt-tabs" onKeyDownCapture={event => {
              // Radix's roving focus reads document.activeElement, which is the host
              // inside a ShadowRoot. Resolve the actual trigger for arrow navigation.
              if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
              const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
              const index = tabs.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              event.preventDefault(); event.stopPropagation();
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              tabs[next].focus(); selectTab(["translation", "explanation", "terms"][next]);
            }}>
              <Tabs.Trigger value="translation" aria-label="Bản dịch" title="Bản dịch"><Languages size={16}/></Tabs.Trigger>
              <Tabs.Trigger value="explanation" aria-label="Giải thích" title="Giải thích"><Sparkles size={16}/></Tabs.Trigger>
              <Tabs.Trigger value="terms" aria-label="Thuật ngữ" title="Thuật ngữ"><BookOpen size={16}/>{result?.terms.length ? <Badge size="1" variant="soft">{result.terms.length}</Badge> : null}</Tabs.Trigger>
            </Tabs.List>
            <div className="avt-tab-body">
              <Tabs.Content value="translation">
                {state.translation ? <p className="avt-translation" aria-live={state.phase === "done" ? "polite" : "off"}>{state.translation}</p> : busy ? <div className="avt-skeleton" role="status" aria-label="Đang nhận bản dịch"><Skeleton height="14px"/><Skeleton height="14px"/><Skeleton height="14px" width="70%"/><Text size="1" color="gray">Đang nhận bản dịch…</Text></div> : null}
                {state.phase === "error" && <div className="avt-error" role="alert"><Text as="p" size="2">{state.error}</Text><Button size="2" variant="soft" onClick={() => void translate(lastMode)}><RotateCcw size={14}/>Thử lại</Button></div>}
              </Tabs.Content>
              <Tabs.Content value="explanation">
                {state.detailPhase === "loading" ? <DetailsLoading/> : state.detailPhase === "error" ? <DetailsError message={state.detailError!}/> : result?.explanation ? <p className="avt-prose">{result.explanation}</p> : <div className="avt-empty"><Sparkles size={24}/><Text size="2">{busy ? "Bản dịch xong sẽ tải giải thích cho bạn." : state.phase === "stopped" ? "Hãy dịch lại để xem giải thích đầy đủ." : "Không có giải thích bổ sung."}</Text></div>}
              </Tabs.Content>
              <Tabs.Content value="terms">
                {state.detailPhase === "loading" ? <DetailsLoading/> : state.detailPhase === "error" ? <DetailsError message={state.detailError!}/> : result?.terms.length ? <div className="avt-terms">{result.terms.map((term, index) => <div className="avt-term" key={index}><Text as="div" size="2" weight="bold">{term.source}</Text><Text as="div" size="2">{term.meaning}</Text>{term.note && <Text as="div" size="1" color="gray">{term.note}</Text>}</div>)}</div> : <div className="avt-empty"><BookOpen size={24}/><Text size="2">{busy ? "Bản dịch xong sẽ tìm thuật ngữ cho bạn." : "Không có thuật ngữ cần giải thích."}</Text></div>}
              </Tabs.Content>
            </div>
          </Tabs.Root>
          {state.error && state.phase !== "error" && <Text as="p" size="1" color="red" className="avt-copy-error" role="alert">{state.error}</Text>}
          <footer className="avt-footer">
            <Flex gap="2" align="center">
              <IconButton size="1" disabled={!state.translation} variant="soft" aria-label={state.copied ? "Đã sao chép" : "Sao chép bản dịch"} title={state.copied ? "Đã sao chép" : "Sao chép bản dịch"} onClick={() => void copyTranslation()}>{state.copied ? <Check size={15}/> : <Copy size={15}/>}</IconButton>
              {state.selection.paragraph && <IconButton size="1" variant="ghost" aria-label="Dịch đoạn song ngữ" title="Chèn bản dịch song ngữ dưới đoạn gốc" onClick={translateParagraph}><Rows2 size={15}/></IconButton>}
              {busy ? <IconButton size="1" variant="ghost" color="gray" aria-label="Dừng dịch" title="Dừng dịch" onClick={() => { cancelPort(); patch({ phase: view.translation ? "stopped" : "idle", error: "" }); }}><Square size={13}/></IconButton> : <IconButton size="1" variant="ghost" color="gray" aria-label="Dịch lại" title="Dịch lại" onClick={() => void translate(lastMode)}><RotateCcw size={15}/></IconButton>}
            </Flex>
            <Flex gap="2" align="center">
              <span className="avt-status" role="status" aria-label={busy ? "Đang xử lý" : state.phase === "error" ? "Cần thử lại" : state.phase === "stopped" ? "Đã dừng" : "Hoàn tất"} title={busy ? "Đang xử lý" : state.cached ? "Dùng lại bản đã lưu" : state.phase === "stopped" ? "Đã dừng" : "Hoàn tất"}>{busy ? <LoaderCircle size={12} className="avt-spin"/> : <span className="avt-status-dot"/>}</span>
              <IconButton size="1" variant="ghost" color="gray" aria-label="Thông tin bản dịch" title={[provider?.name, provider?.model, quotaLabel, "Esc để đóng"].filter(Boolean).join(" · ")}><Info size={14}/></IconButton>
            </Flex>
          </footer>
        </>}
      </Card>}
    </div>
  </Theme>;
}
function DetailsLoading() { return <div className="avt-empty" role="status"><LoaderCircle size={20} className="avt-spin"/><Text size="2">Đang lấy giải thích và thuật ngữ…</Text><Text size="1" color="gray">Chỉ tải khi bạn mở tab này.</Text></div>; }
function DetailsError({ message }: { message: string }) { return <div className="avt-error" role="alert"><Text size="2">{message}</Text><Button variant="soft" size="2" onClick={() => void loadDetails()}>Thử lại</Button></div>; }
const reactRoot = createRoot(mount);
reactRoot.render(<TranslationOverlay/>);
// Load metadata once, without delaying the selection launcher on service-worker wakeup.
void refreshState();
function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== "local" || !changes.aiVietnameseTranslatorState?.newValue) return;
  appState = changes.aiVietnameseTranslatorState.newValue as AppState;
  if (appState.preferences?.showFloatingButton === false && view.phase === "idle") close();
  else updateView?.({ ...view });
}
chrome.storage?.onChanged?.addListener(onStorageChanged);
host.addEventListener("avt:dispose", () => {
  stopWatchingSelection();
  document.removeEventListener("keydown", onKeyDown, true);
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  chrome.storage?.onChanged?.removeListener(onStorageChanged);
  close(); reactRoot.unmount(); host.remove();
}, { once: true });
