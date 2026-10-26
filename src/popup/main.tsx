import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Clock, Settings, RefreshCw, Search, Trash2, Languages, Copy, Check, ArrowUpRight } from "lucide-react";
import { toneLabels, translationModeLabels } from "../shared/defaults";
import type { AppState, Preferences, RuntimeMessage, TranslateResponse, TranslationResult } from "../shared/types";
import "../shared/ui.css";
import "./style.css";

function PopupApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [saving, setSaving] = useState(false);
  const send = <T,>(message: RuntimeMessage) => chrome.runtime.sendMessage(message) as Promise<T>;
  useEffect(() => { void loadState().catch(() => setError("Không tải được dữ liệu. Hãy mở lại tiện ích.")); }, []);
  const history = useMemo(() => (state?.history ?? []).filter(item =>
    !query.trim() || `${item.sourceText} ${item.result.translation}`.toLowerCase().includes(query.trim().toLowerCase())
  ).slice(0, 6), [state, query]);

  async function loadState() { setState(await send<AppState>({ type: "GET_STATE" })); }
  async function update(patch: Partial<AppState>) {
    setSaving(true); setError("");
    try { setState(await send<AppState>({ type: "SAVE_STATE", state: patch })); }
    catch { setError("Không lưu được tùy chọn. Vui lòng thử lại."); }
    finally { setSaving(false); }
  }
  async function preferences(patch: Partial<Preferences>) {
    if (state) await update({ preferences: { ...state.preferences, ...patch } });
  }
  async function translate() {
    if (!text.trim() || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await send<TranslateResponse>({ type: "TRANSLATE_SELECTION", text });
      if (!response.ok || !response.result) throw new Error(response.error || "Chưa nhận được bản dịch.");
      setResult(response.result); await loadState();
    } catch (e) { setError(e instanceof Error ? e.message : "Không dịch được. Vui lòng thử lại."); }
    finally { setBusy(false); }
  }
  async function copy(id: string, value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(id); window.setTimeout(() => setCopied(""), 1500); }
    catch { setError("Không thể sao chép. Bạn có thể chọn và sao chép văn bản trực tiếp."); }
  }
  async function remove(id: string) {
    try { setState(await send<AppState>({ type: "DELETE_HISTORY_ITEM", id })); }
    catch { setError("Không xóa được bản dịch. Vui lòng thử lại."); }
  }
  async function refresh() {
    if (!state || refreshing) return;
    setRefreshing(true);
    try {
      const response = await send<{ok: boolean; error?: string}>({ type: "REFRESH_PROVIDER_USAGE", providerId: state.activeProviderId });
      if (!response.ok) setError(response.error || "Chưa cập nhật được hạn mức.");
      await loadState();
    } catch { setError("Không cập nhật được hạn mức."); }
    finally { setRefreshing(false); }
  }
  const openHistory = () => chrome.tabs.create({ url: chrome.runtime.getURL("src/history/index.html") });
  if (!state) return <main className="popup"><Languages size={28}/><p role="status">{error || "Đang tải tiện ích…"}</p></main>;
  const active = state.providers.find(p => p.id === state.activeProviderId);
  const usage = active ? state.usageCache[active.id] : undefined;
  return <main className="popup">
    <header><div className="brand"><span className="brand-mark"><Languages size={22}/></span><div><h1>AI Translator</h1><p>Hiểu rõ hơn, qua từng bản dịch</p></div></div>
      <div className="header-actions"><button className="icon" onClick={openHistory} title="Lịch sử dịch" aria-label="Lịch sử dịch"><Clock size={18}/></button><button className="icon" onClick={() => chrome.runtime.openOptionsPage()} title="Cài đặt" aria-label="Cài đặt"><Settings size={18}/></button></div>
    </header>
    <section className="quick"><label>Nhà cung cấp<select disabled={busy || saving} value={state.activeProviderId} onChange={e => void update({ activeProviderId: e.target.value })}>{state.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Chế độ dịch<select disabled={busy || saving} value={state.preferences.translationMode} onChange={e => void preferences({ translationMode: e.target.value as Preferences["translationMode"] })}>{Object.entries(translationModeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="wide">Văn phong<select disabled={busy || saving} value={state.preferences.tone} onChange={e => void preferences({ tone: e.target.value as Preferences["tone"] })}>{Object.entries(toneLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    </section>
    <section className="composer"><div className="section-title"><h2>Dịch sang tiếng Việt</h2><span>Tự nhận diện ngôn ngữ</span></div>
      <label className="sr-only" htmlFor="translate-text">Văn bản cần dịch</label><textarea id="translate-text" value={text} disabled={busy} onChange={e => setText(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void translate(); } }} placeholder="Nhập hoặc dán văn bản cần dịch…" rows={4}/>
      <div className="composer-footer"><span>{text.length.toLocaleString("vi-VN")} ký tự · Ctrl/⌘ + Enter</span><button className="primary" disabled={!text.trim() || busy || saving} onClick={() => void translate()}>{busy ? <RefreshCw size={16} className="spin"/> : <Languages size={16}/>} {busy ? "Đang dịch…" : "Dịch ngay"}</button></div>
    </section>
    {error && <p className="notice error" role="alert">{error}</p>}
    {result && <section className="result-card" aria-live="polite"><div className="section-title"><h2>Bản dịch</h2><button className="text-button" onClick={() => void copy("result", result.translation)}>{copied === "result" ? <Check size={15}/> : <Copy size={15}/>} {copied === "result" ? "Đã sao chép" : "Sao chép"}</button></div><p>{result.translation}</p>{result.explanation && <details><summary>Giải thích bản dịch</summary><p>{result.explanation}</p></details>}{result.terms.length > 0 && <details><summary>Thuật ngữ ({result.terms.length})</summary>{result.terms.map((t, i) => <p key={i}><strong>{t.source}</strong>: {t.meaning}{t.note && ` — ${t.note}`}</p>)}</details>}</section>}
    {active && shouldShowQuota(active) && <section className="quota-card"><div><span>Hạn mức · {active.quotaAccountName || "Chưa chọn tài khoản"}</span><strong>{formatUsage(usage)}</strong><p>{formatUsageMeta(usage)}</p></div><button className="icon" disabled={refreshing} onClick={() => void refresh()} aria-label="Cập nhật hạn mức" title="Cập nhật hạn mức"><RefreshCw size={16} className={refreshing ? "spin" : ""}/></button></section>}
    <section className="history-head"><h2>Gần đây <span className="count">{state.history.length}</span></h2><button className="text-button" onClick={openHistory}>Xem tất cả <ArrowUpRight size={14}/></button></section>
    {state.history.length > 0 && <label className="search"><Search size={16}/><input aria-label="Tìm bản dịch" value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm trong lịch sử…"/></label>}
    <section className="history">{history.map(item => <article className="history-item" key={item.id}><div className="history-top"><time>{new Date(item.createdAt).toLocaleString("vi-VN", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" })}</time><div className="header-actions"><button className="mini" title="Sao chép bản dịch" aria-label="Sao chép bản dịch" onClick={() => void copy(item.id, item.result.translation)}>{copied === item.id ? <Check size={14}/> : <Copy size={14}/>}</button><button className="mini danger" title="Xóa bản dịch" aria-label="Xóa bản dịch" onClick={() => void remove(item.id)}><Trash2 size={14}/></button></div></div><p className="source">{item.sourceText}</p><p className="translation">{item.result.translation}</p></article>)}{!history.length && <div className="empty"><Languages size={24}/><p>{query ? "Không tìm thấy bản dịch phù hợp." : "Bản dịch của bạn sẽ xuất hiện tại đây."}</p>{query ? <button className="text-button" onClick={() => setQuery("")}>Xóa tìm kiếm</button> : <small>Bôi đen trên trang web, rồi nhấn Alt + Shift + T.</small>}</div>}</section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<PopupApp />);

function shouldShowQuota(provider: AppState["providers"][number]): boolean {
  return isProxyProvider(provider.baseUrl) || provider.quotaSource === "localhost-proxy" || Boolean(provider.quotaAccountId);
}

function isProxyProvider(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "localhost" && url.port === "20128";
  } catch {
    return false;
  }
}

function formatUsage(usage: AppState["usageCache"][string] | undefined): string {
  if (!usage) return "usage chưa có";
  if (usage.error) return "quota lỗi";
  const used = formatNumber(usage.usage);
  const limit = formatNumber(usage.limit);
  if (used && limit) return `${used} / ${limit}`;
  return used || "usage chưa có";
}

function formatUsageMeta(usage: AppState["usageCache"][string] | undefined): string {
  if (!usage || usage.error) return usage?.error || "";
  const parts = [];
  if (typeof usage.percent === "number") parts.push(`${Math.round(usage.percent)}%`);
  if (usage.refreshText) parts.push(usage.refreshText);
  if (usage.resetAt) parts.push(`reset ${new Date(usage.resetAt).toLocaleTimeString("vi-VN")}`);
  parts.push(new Date(usage.updatedAt).toLocaleTimeString("vi-VN"));
  return parts.join(" · ");
}

function formatNumber(value?: number): string {
  return typeof value === "number" ? Number(value.toFixed(4)).toString() : "";
}
