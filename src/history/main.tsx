import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Copy, Download, ExternalLink, Search, Trash2 } from "lucide-react";
import type { AppState, RuntimeMessage, TranslateResponse } from "../shared/types";
import "../shared/ui.css";
import "./style.css";

function HistoryApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState("");
  const [loadingDetails, setLoadingDetails] = useState<string[]>([]);
  const [sort, setSort] = useState("newest");
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState("all");
  const [copiedId, setCopiedId] = useState("");

  useEffect(() => {
    void loadState().catch(() => setError("Không tải được lịch sử. Vui lòng mở lại trang."));
  }, []);

  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (state?.history ?? []).filter((item) => {
      const matchesProvider = providerId === "all" || item.providerId === providerId;
      const matchesQuery =
        !normalized ||
        item.sourceText.toLowerCase().includes(normalized) ||
        item.result.translation.toLowerCase().includes(normalized) ||
        item.result.explanation.toLowerCase().includes(normalized);
      return matchesProvider && matchesQuery;
    }).sort((a, b) => sort === "newest" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
  }, [providerId, query, state, sort]);

  async function loadState() {
    const next = (await chrome.runtime.sendMessage({ type: "GET_STATE" } satisfies RuntimeMessage)) as AppState;
    setState(next);
  }

  async function historyAction(action: () => Promise<void>) {
    try { await action(); } catch { setError("Không cập nhật được lịch sử. Vui lòng thử lại."); }
  }

  async function loadDetails(id: string) {
    if (loadingDetails.includes(id)) return;
    setLoadingDetails(items => [...items, id]);
    try {
      const response = await chrome.runtime.sendMessage({ type: "EXPLAIN_TRANSLATION", historyId: id } satisfies RuntimeMessage) as TranslateResponse;
      if (!response.ok) throw new Error(response.error || "Không lấy được giải thích.");
      await loadState();
    } catch (error) { setError(error instanceof Error ? error.message : "Không tải được giải thích."); }
    finally { setLoadingDetails(items => items.filter(item => item !== id)); }
  }

  async function deleteHistoryItem(id: string) {
    const next = (await chrome.runtime.sendMessage({
      type: "DELETE_HISTORY_ITEM",
      id
    } satisfies RuntimeMessage)) as AppState;
    setState(next);
  }

  async function clearHistory() {
    if (!window.confirm(`Xóa toàn bộ ${state?.history.length ?? 0} bản dịch? Thao tác này không thể hoàn tác.`)) return;
    const next = (await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" } satisfies RuntimeMessage)) as AppState;
    setState(next);
  }

  async function copyTranslation(id: string, translation: string) {
    try { await navigator.clipboard.writeText(translation); }
    catch { setError("Không thể sao chép. Hãy chọn và sao chép văn bản trực tiếp."); return; }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(""), 1200);
  }

  function exportHistory() {
    const data = items.map(item => [
      new Date(item.createdAt).toLocaleString("vi-VN"),
      `${item.providerName} · ${item.model}`,
      `VĂN BẢN GỐC\n${item.sourceText}`,
      `BẢN DỊCH\n${item.result.translation}`,
      item.result.explanation ? `GIẢI THÍCH\n${item.result.explanation}` : "",
      item.result.terms.length ? `THUẬT NGỮ\n${item.result.terms.map(term => `${term.source}: ${term.meaning}${term.note ? ` — ${term.note}` : ""}`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n")).join("\n\n────────────────────────────\n\n");
    const url = URL.createObjectURL(new Blob([data], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `lich-su-dich-${new Date().toLocaleDateString("sv-SE")}.txt`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  if (!state) return <main className="page"><p role="status">{error || "Đang tải lịch sử…"}</p></main>;

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>Lịch sử dịch</h1>
          <p>{state.history.length} bản dịch đã lưu</p>
        </div>
        <div className="top-actions">
          <button className="secondary" onClick={openOptions}>
            <ExternalLink size={16} />
            <span>Cài đặt</span>
          </button>
          <button className="secondary" disabled={!items.length} onClick={exportHistory}><Download size={16}/><span>Xuất bản dịch</span></button>
          <button className="danger" disabled={!state.history.length} onClick={() => void historyAction(clearHistory)}>
            <Trash2 size={16} />
            <span>Xóa hết</span>
          </button>
        </div>
      </header>

      {error && <p className="notice error" role="alert">{error}</p>}
      <section className="filters">
        <label className="search">
          <Search size={17} />
          <input aria-label="Tìm trong lịch sử" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm trong bản gốc, bản dịch, giải thích" />
        </label>
        <label>
          Nhà cung cấp
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            <option value="all">Tất cả</option>
            {Array.from(new Map([...state.providers.map(p => [p.id, p.name] as const), ...state.history.map(item => [item.providerId, item.providerName] as const)]).entries()).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>Sắp xếp<select value={sort} onChange={e => setSort(e.target.value)}><option value="newest">Mới nhất trước</option><option value="oldest">Cũ nhất trước</option></select></label>
      </section>
      <div className="results-line"><span>{items.length} / {state.history.length} bản dịch</span>{(query || providerId !== "all") && <button className="text-button" onClick={() => { setQuery(""); setProviderId("all"); }}>Xóa bộ lọc</button>}</div>
      <section className="list">
        {items.map((item) => (
          <article className="item" key={item.id}>
            <div className="item-head">
              <div>
                <time>{new Date(item.createdAt).toLocaleString("vi-VN")}</time>
                <span>{item.providerName} / {item.model}</span>
              </div>
              <div className="item-actions">
                <button className="secondary" onClick={() => copyTranslation(item.id, item.result.translation)}>
                  <Copy size={15} />
                  <span>{copiedId === item.id ? "Đã sao chép" : "Sao chép"}</span>
                </button>
                <button className="icon danger" onClick={() => void historyAction(() => deleteHistoryItem(item.id))} title="Xóa">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            <div className="columns">
              <section>
                <h2>Văn bản gốc</h2>
                <p>{item.sourceText}</p>
              </section>
              <section>
                <h2>Bản dịch</h2>
                <p>{item.result.translation}</p>
              </section>
            </div>

            {item.result.detailsLoaded === false && <button className="secondary" disabled={loadingDetails.includes(item.id)} onClick={() => void loadDetails(item.id)}>{loadingDetails.includes(item.id) ? "Đang tải giải thích…" : "Xem giải thích và thuật ngữ"}</button>}
            {item.result.explanation && (
              <section className="explanation">
                <h2>Giải thích</h2>
                <p>{item.result.explanation}</p>
              </section>
            )}

            {item.result.terms.length > 0 && (
              <section className="terms">
                <h2>Thuật ngữ</h2>
                <div className="term-grid">
                  {item.result.terms.map((term, index) => (
                    <div className="term" key={`${term.source}-${index}`}>
                      <strong>{term.source}</strong>
                      <span>{term.meaning}</span>
                      {term.note && <em>{term.note}</em>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </article>
        ))}
        {!items.length && <div className="empty"><Search size={28}/><p>{state.history.length ? "Không tìm thấy bản dịch phù hợp. Thử từ khóa khác hoặc xóa bộ lọc." : "Chưa có bản dịch. Bôi đen văn bản trên trang web rồi nhấn Alt + Shift + T để bắt đầu."}</p></div>}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<HistoryApp />);
