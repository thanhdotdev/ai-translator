import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckCircle, Clock, Database, Plus, RefreshCw, Save, Trash2, Wifi } from "lucide-react";
import { defaultProvider, toneLabels, translationModeLabels } from "../shared/defaults";
import { createId } from "../shared/storage";
import type {
  AppState,
  GlossaryTerm,
  ProviderConfig,
  RuntimeMessage,
  TonePreset,
  TranslationMode
} from "../shared/types";
import "../shared/ui.css";
import "./style.css";

function OptionsApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [headersText, setHeadersText] = useState("{}");
  const [savedConfig, setSavedConfig] = useState("");
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [quotaStatus, setQuotaStatus] = useState("");
  const [quotaDebugPreview, setQuotaDebugPreview] = useState("");

  useEffect(() => {
    void loadState().catch(() => setStatus("Không tải được cài đặt. Hãy mở lại trang để thử lại."));
  }, []);

  const selectedProvider = useMemo(
    () => state?.providers.find((provider) => provider.id === selectedProviderId) ?? state?.providers[0],
    [selectedProviderId, state]
  );

  async function loadState(options: { preserveSelectedProviderId?: string } = {}) {
    const next = (await chrome.runtime.sendMessage({ type: "GET_STATE" } satisfies RuntimeMessage)) as AppState;
    setState(next);
    setSavedConfig(configSnapshot(next));
    const provider =
      next.providers.find((item) => item.id === options.preserveSelectedProviderId) ??
      next.providers.find((item) => item.id === next.activeProviderId) ??
      next.providers[0];
    setSelectedProviderId(provider.id);
    setHeadersText(JSON.stringify(provider.headers, null, 2));
  }

  const dirty = Boolean(state && (configSnapshot(state) !== savedConfig || headersText !== JSON.stringify(selectedProvider?.headers, null, 2)));
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  function parsedHeaders(): Record<string, string> {
    const parsed: unknown = JSON.parse(headersText);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some(value => typeof value !== "string")) {
      throw new Error("Headers phải là JSON object với các giá trị dạng chuỗi.");
    }
    return parsed as Record<string, string>;
  }

  async function save(patch: Partial<AppState> = {}): Promise<boolean> {
    if (!state || saving) return false;
    setSaving(true);
    try {
      const headers = parsedHeaders();
      const providers = state.providers.map(provider => provider.id === selectedProvider?.id ? { ...provider, headers } : provider);
      for (const provider of providers) {
        if (!provider.name.trim() || !provider.model.trim()) throw new Error("Vui lòng nhập tên và model cho mỗi nhà cung cấp.");
        let url: URL;
        try { url = new URL(provider.baseUrl); } catch { throw new Error(`Địa chỉ API của ${provider.name} chưa hợp lệ.`); }
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Địa chỉ API phải bắt đầu bằng http:// hoặc https://.");
      }
      const next = await chrome.runtime.sendMessage({ type: "SAVE_STATE", state: {
        providers, activeProviderId: state.activeProviderId, preferences: state.preferences, glossary: state.glossary, ...patch
      } } satisfies RuntimeMessage) as AppState;
      setState(next); setSavedConfig(configSnapshot(next));
      setHeadersText(JSON.stringify(headers, null, 2));
      setStatus("Đã lưu tất cả thay đổi.");
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Không lưu được cấu hình. Vui lòng thử lại.");
      return false;
    } finally { setSaving(false); }
  }

  function updateProvider(patch: Partial<ProviderConfig>) {
    if (!state || !selectedProvider) return;
    const providers = state.providers.map((provider) =>
      provider.id === selectedProvider.id ? { ...provider, ...patch } : provider
    );
    setState({ ...state, providers });
  }

  function selectProvider(id: string) {
    if (!state) return;
    const provider = state.providers.find((item) => item.id === id);
    if (!provider) return;
    try {
      const headers = parsedHeaders();
      setState({ ...state, providers: state.providers.map(item => item.id === selectedProvider?.id ? { ...item, headers } : item) });
    } catch { setStatus("Headers chưa hợp lệ. Vui lòng sửa trước khi chuyển nhà cung cấp."); return; }
    setTestStatus(""); setShowKey(false);
    setSelectedProviderId(id);
    setHeadersText(JSON.stringify(provider.headers, null, 2));
  }

  function addProvider() {
    if (!state) return;
    let headers: Record<string, string>;
    try { headers = parsedHeaders(); } catch { setStatus("Vui lòng sửa headers trước khi thêm nhà cung cấp."); return; }
    const provider: ProviderConfig = {
      ...defaultProvider,
      id: createId("provider"),
      name: "Custom Provider",
      apiKey: "",
      headers: {}
    };
    setState({ ...state, providers: [...state.providers.map(item => item.id === selectedProvider?.id ? { ...item, headers } : item), provider] });
    setSelectedProviderId(provider.id);
    setHeadersText("{}");
  }

  function deleteProvider(id: string) {
    if (!state || state.providers.length <= 1) return;
    if (!window.confirm("Xóa nhà cung cấp này? Thay đổi có hiệu lực khi bạn lưu.")) return;
    const providers = state.providers.filter((provider) => provider.id !== id);
    const activeProviderId = state.activeProviderId === id ? providers[0].id : state.activeProviderId;
    setState({ ...state, providers, activeProviderId });
    setSelectedProviderId(activeProviderId);
    setHeadersText(JSON.stringify(providers.find(item => item.id === activeProviderId)!.headers, null, 2));
  }

  async function testProvider() {
    if (!selectedProvider) return;
    setTestStatus("Đang kiểm tra…");
    try {
      const response = await chrome.runtime.sendMessage({ type: "TEST_PROVIDER", provider: { ...selectedProvider, headers: parsedHeaders() } } satisfies RuntimeMessage) as { ok: boolean; error?: string };
      setTestStatus(response.ok ? "Kết nối thành công." : response.error || "Không kết nối được.");
    } catch (error) { setTestStatus(error instanceof Error ? error.message : "Không kiểm tra được kết nối."); }
  }

  async function syncQuotaAccounts() {
    if (!selectedProvider) return;
    if (!(await save())) return;
    setQuotaStatus("Đang đồng bộ tài khoản…");
    const response = (await chrome.runtime.sendMessage({
      type: "SYNC_PROXY_QUOTA_ACCOUNTS",
      provider: { ...selectedProvider, headers: parsedHeaders() }
    } satisfies RuntimeMessage)) as { ok: boolean; accounts?: unknown[]; preview?: string; error?: string };
    await loadState({ preserveSelectedProviderId: selectedProvider.id });
    setQuotaDebugPreview(response.preview || "");
    setQuotaStatus(
      response.ok
        ? `Đã sync accounts: ${response.accounts?.length ?? 0}.`
        : response.error || "Không sync được accounts."
    );
  }

  async function debugQuotaAccounts() {
    if (!selectedProvider) return;
    setQuotaStatus("Đang đọc debug payload...");
    const response = (await chrome.runtime.sendMessage({
      type: "DEBUG_PROXY_QUOTA_ACCOUNTS",
      provider: { ...selectedProvider, headers: parsedHeaders() }
    } satisfies RuntimeMessage)) as { ok: boolean; preview?: string; error?: string };
    setQuotaDebugPreview(response.preview || "");
    setQuotaStatus(response.ok ? "Đã đọc debug payload." : response.error || "Không đọc được debug payload.");
  }

  async function enableProxyCookie() {
    try {
      const granted = await chrome.permissions.request({ permissions: ["cookies"] });
      if (!granted) { setQuotaStatus("Bạn chưa cho phép đọc cookie. Các chức năng dịch vẫn dùng bình thường bằng API key."); return; }
      await checkAuthCookie();
    } catch { setQuotaStatus("Chưa bật được quyền cookie cho proxy."); }
  }

  async function checkAuthCookie() {
    if (!selectedProvider) return;
    setQuotaStatus("Đang kiểm tra auth_token cookie...");
    const response = (await chrome.runtime.sendMessage({
      type: "CHECK_LOCAL_PROXY_AUTH_COOKIE",
      provider: { ...selectedProvider, headers: parsedHeaders() }
    } satisfies RuntimeMessage)) as { ok: boolean; found: boolean; checked: string[]; source?: string; error?: string };
    if (!response.ok) {
      setQuotaStatus(response.error || "Không kiểm tra được auth_token cookie.");
      return;
    }
    setQuotaStatus(
      response.found
        ? `Found auth_token tại ${response.source}.`
        : `Không thấy auth_token. Đã check: ${response.checked.join(", ")}`
    );
  }

  async function testUsage() {
    if (!selectedProvider) return;
    if (!(await save())) return;
    setQuotaStatus("Đang lấy mức sử dụng…");
    const response = (await chrome.runtime.sendMessage({
      type: "REFRESH_PROVIDER_USAGE_FOR_PROVIDER",
      provider: { ...selectedProvider, headers: parsedHeaders() }
    } satisfies RuntimeMessage)) as { ok: boolean; error?: string };
    await loadState({ preserveSelectedProviderId: selectedProvider.id });
    setQuotaStatus(response.ok ? "Usage đã cập nhật." : response.error || "Không lấy được usage.");
  }

  function addGlossaryTerm() {
    if (!state) return;
    const term: GlossaryTerm = {
      id: createId("term"),
      source: "",
      target: "",
      mode: "translate"
    };
    setState({ ...state, glossary: [...state.glossary, term] });
  }

  function updateGlossaryTerm(id: string, patch: Partial<GlossaryTerm>) {
    if (!state) return;
    setState({
      ...state,
      glossary: state.glossary.map((term) => (term.id === id ? { ...term, ...patch } : term))
    });
  }

  async function quotaAction(action: () => Promise<void>) {
    try { await action(); } catch { setQuotaStatus("Không kết nối được proxy. Vui lòng kiểm tra kết nối và thử lại."); }
  }

  function openHistory() {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/history/index.html") });
  }

  if (!state || !selectedProvider) return <main className="page"><p role="status">{status || "Đang tải cài đặt…"}</p></main>;
  const isLocalhostProxy = isProxyProvider(selectedProvider.baseUrl);
  const currentUsage = state.usageCache[selectedProvider.id];

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>AI Vietnamese Translator</h1>
          <p>Quản lý kết nối AI và cá nhân hóa cách dịch của bạn.</p>
        </div>
        
        <button className="secondary" onClick={openHistory}>
          <Clock size={17} />
          <span>Lịch sử dịch</span>
        </button>
      </header>

      <div className="notice" role="note">Khi bạn nhấn dịch, phần được chọn và ngữ cảnh đang bật sẽ gửi đến nhà cung cấp AI bạn cấu hình. Mở phát âm sẽ gửi từ cần tra đến WiktAPI/Wiktionary; phát audio có thể kết nối Wikimedia hoặc dịch vụ giọng nói của trình duyệt. API key, cấu hình và lịch sử được lưu trên máy. <a href={chrome.runtime.getURL("privacy.html")} target="_blank" rel="noreferrer">Chính sách quyền riêng tư</a></div>
      <nav className="section-nav" aria-label="Các mục cài đặt"><a href="#connection">Kết nối AI</a><a href="#preferences">Tùy chọn dịch</a><a href="#glossary">Từ điển riêng</a></nav>
      {status && <div className="notice" role="status">{status}</div>}
      <div className="save-bar"><span>{dirty ? "Có thay đổi chưa lưu" : "Cấu hình đã được lưu"}</span><button className="primary" disabled={saving || !dirty} onClick={() => void save()}><Save size={16}/>{saving ? "Đang lưu…" : "Lưu thay đổi"}</button></div>

      <section className="layout">
        <aside className="sidebar">
          <div className="section-head">
            <h2>Nhà cung cấp</h2>
            <button className="icon" disabled={saving} onClick={addProvider} aria-label="Thêm nhà cung cấp" title="Thêm nhà cung cấp">
              <Plus size={17} />
            </button>
          </div>
          <div className="provider-list">
            {state.providers.map((provider) => (
              <button
                className={provider.id === selectedProvider.id ? "provider active" : "provider"}
                key={provider.id}
                disabled={saving} aria-pressed={provider.id === selectedProvider.id} onClick={() => selectProvider(provider.id)}
              >
                <strong>{provider.name}</strong>
                <span>{provider.model}</span>{provider.id === state.activeProviderId && <em className="badge">Đang sử dụng</em>}
              </button>
            ))}
          </div>
        </aside>

        <fieldset disabled={saving} className="content">
          <div className="panel" id="connection">
            <div className="section-head">
              <h2>Kết nối AI</h2>
              <div className="actions">
                <button className="secondary" disabled={testStatus === "Đang kiểm tra…" || saving} onClick={testProvider}>
                  <Wifi size={16} />
                  <span>Kiểm tra</span>
                </button>
                <button
                  className="secondary"
                  onClick={() => save({ activeProviderId: selectedProvider.id })}
                >
                  <CheckCircle size={16} />
                  <span>{state.activeProviderId === selectedProvider.id ? "Đang sử dụng" : "Dùng nhà cung cấp này"}</span>
                </button>
                <button className="danger" title="Xóa nhà cung cấp" aria-label="Xóa nhà cung cấp" disabled={state.providers.length <= 1} onClick={() => deleteProvider(selectedProvider.id)}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            {testStatus && <div className="inline-status">{testStatus}</div>}
            <div className="form-grid">
              <label>
                Tên
                <input value={selectedProvider.name} onChange={(event) => updateProvider({ name: event.target.value })} />
              </label>
              <label>
                Base URL
                <input
                  value={selectedProvider.baseUrl}
                  onChange={(event) => updateProvider({ baseUrl: event.target.value })}
                  placeholder="https://openrouter.ai/api/v1"
                />
              </label>
              <label>
                Model
                <input
                  value={selectedProvider.model}
                  onChange={(event) => updateProvider({ model: event.target.value })}
                  placeholder="openai/gpt-4o-mini"
                />
              </label>
              <div className="key-field"><label>
                API key
                <input
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={selectedProvider.apiKey}
                  onChange={(event) => updateProvider({ apiKey: event.target.value })}
                  placeholder="sk-or-..."
                /></label><button className="text-button" onClick={() => setShowKey(!showKey)}>{showKey ? "Ẩn khóa API" : "Hiện khóa API"}</button>
              </div>
              <details className="wide advanced"><summary>Headers tùy chỉnh · Nâng cao</summary><label>
                Headers JSON
                <textarea value={headersText} onChange={(event) => setHeadersText(event.target.value)} rows={5} spellCheck={false} />
              </label></details>
            </div>
            <button className="primary" disabled={saving} onClick={() => void save()}>
              <Save size={16} />
              <span>Lưu cấu hình</span>
            </button>
          </div>

          {isLocalhostProxy && (
            <div className="panel">
              <div className="section-head">
                <h2>Hạn mức proxy</h2>
                <div className="actions">
                  <button className="secondary" disabled={saving} onClick={() => void quotaAction(syncQuotaAccounts)}>
                    <Database size={16} />
                    <span>Đồng bộ tài khoản</span>
                  </button>
                  <button className="secondary" disabled={saving} onClick={() => void quotaAction(debugQuotaAccounts)}>
                    <Database size={16} />
                    <span>Debug payload</span>
                  </button>
                  <button className="secondary" disabled={saving} onClick={() => void quotaAction(enableProxyCookie)}>
                    <Database size={16} />
                    <span>Cho phép cookie proxy</span>
                  </button>
                  <button className="secondary" disabled={saving} onClick={() => void quotaAction(testUsage)}>
                    <RefreshCw size={16} />
                    <span>Cập nhật hạn mức</span>
                  </button>
                </div>
              </div>
              <p className="section-description">Quyền cookie là tùy chọn, chỉ dùng phiên đăng nhập proxy localhost trên máy này để hỗ trợ kiểm tra tài khoản và hạn mức.</p>
              {quotaStatus && <div className="inline-status">{quotaStatus}</div>}
              <div className="form-grid">
                <label>
                  Quota account
                  <select
                    value={selectedProvider.quotaAccountId || ""}
                    onChange={(event) => {
                      const account = state.proxyQuotaAccounts.find((item) => item.id === event.target.value);
                      updateProvider({
                        quotaSource: "localhost-proxy",
                        quotaAccountId: account?.id || "",
                        quotaAccountName: account?.name || "",
                        quotaModelPrefix: selectedProvider.quotaModelPrefix || modelPrefix(selectedProvider.model)
                      });
                    }}
                  >
                    <option value="">Chọn account</option>
                    {state.proxyQuotaAccounts.map((account) => (
                      <option value={account.id} key={account.id}>
                        {account.name} {account.label !== account.name ? `- ${account.label}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Model prefix
                  <input
                    value={selectedProvider.quotaModelPrefix || modelPrefix(selectedProvider.model)}
                    onChange={(event) =>
                      updateProvider({
                        quotaSource: "localhost-proxy",
                        quotaModelPrefix: event.target.value
                      })
                    }
                    placeholder="kr"
                  />
                </label>
              </div>
              <div className="quota-card">
                <strong>{selectedProvider.quotaAccountName || "Chưa chọn account"}</strong>
                <span>{formatUsage(currentUsage)}</span>
                <em>{formatUsageMeta(currentUsage)}</em>
              </div>
              {quotaDebugPreview && (
                <label className="wide debug-preview">
                  API preview
                  <textarea readOnly rows={8} value={quotaDebugPreview} />
                </label>
              )}
              <button className="primary" onClick={() => save()}>
                <Save size={16} />
                <span>Lưu quota mapping</span>
              </button>
            </div>
          )}

          <div className="panel" id="preferences">
            <h2>Tùy chọn dịch</h2><p className="section-description">Chọn cách trình bày phù hợp với nội dung bạn thường đọc.</p>
            <div className="form-grid">
              <label>
                Chế độ dịch
                <select
                  value={state.preferences.translationMode}
                  onChange={(event) =>
                    setState({
                      ...state,
                      preferences: {
                        ...state.preferences,
                        translationMode: event.target.value as TranslationMode
                      }
                    })
                  }
                >
                  {Object.entries(translationModeLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Văn phong
                <select
                  value={state.preferences.tone}
                  onChange={(event) =>
                    setState({
                      ...state,
                      preferences: { ...state.preferences, tone: event.target.value as TonePreset }
                    })
                  }
                >
                  {Object.entries(toneLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={state.preferences.cacheEnabled}
                  onChange={(event) =>
                    setState({
                      ...state,
                      preferences: { ...state.preferences, cacheEnabled: event.target.checked }
                    })
                  }
                />
                <span>Dùng lại bản dịch đã lưu để dịch nhanh hơn</span>
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={state.preferences.showFloatingButton}
                  onChange={(event) =>
                    setState({
                      ...state,
                      preferences: { ...state.preferences, showFloatingButton: event.target.checked }
                    })
                  }
                />
                <span>Hiện nút dịch nổi khi bôi đen</span>
              </label>
              <label>
                Thời gian chờ (giây)
                <input
                  type="number"
                  min={5}
                  max={180}
                  value={Math.round(state.preferences.timeoutMs / 1000)}
                  onChange={(event) =>
                    setState({
                      ...state,
                      preferences: {
                        ...state.preferences,
                        timeoutMs: Math.min(180, Math.max(5, Number(event.target.value) || 45)) * 1000
                      }
                    })
                  }
                />
              </label>
              <label className="wide">
                Prompt bổ sung
                <textarea
                  rows={5}
                  value={state.preferences.customPrompt}
                  onChange={(event) =>
                    setState({
                      ...state,
                      preferences: { ...state.preferences, customPrompt: event.target.value }
                    })
                  }
                  placeholder="Ví dụ: giải thích ví dụ kỹ thuật bằng ngôn ngữ gần gũi hơn."
                />
              </label>
            </div>
          </div>

          <div className="panel" id="glossary">
            <div className="section-head">
              <h2>Từ điển riêng</h2>
              <button className="secondary" onClick={addGlossaryTerm}>
                <Plus size={16} />
                <span>Thêm thuật ngữ</span>
              </button>
            </div>
            <div className="glossary-list">
              {state.glossary.map((term) => (
                <div className="glossary-row" key={term.id}>
                  <input
                    aria-label="Thuật ngữ gốc" value={term.source}
                    onChange={(event) => updateGlossaryTerm(term.id, { source: event.target.value })}
                    placeholder="event-driven pipeline"
                  />
                  <input
                    aria-label="Cách dịch mong muốn" value={term.target}
                    onChange={(event) => updateGlossaryTerm(term.id, { target: event.target.value })}
                    placeholder="pipeline hướng sự kiện"
                  />
                  <select aria-label="Cách xử lý thuật ngữ" value={term.mode} onChange={(event) => updateGlossaryTerm(term.id, { mode: event.target.value as GlossaryTerm["mode"] })}>
                    <option value="translate">Dịch</option>
                    <option value="keep">Giữ nguyên</option>
                  </select>
                  <button
                    className="danger" aria-label="Xóa thuật ngữ" title="Xóa thuật ngữ"
                    onClick={() =>
                      setState({ ...state, glossary: state.glossary.filter((item) => item.id !== term.id) })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {!state.glossary.length && <p className="empty">Chưa có thuật ngữ tùy chỉnh.</p>}
            </div>
          </div>
        </fieldset>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<OptionsApp />);

function isProxyProvider(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "localhost" && url.port === "20128";
  } catch {
    return false;
  }
}

function modelPrefix(model: string): string {
  return model.includes("/") ? model.split("/")[0] : "";
}

function formatUsage(usage: AppState["usageCache"][string] | undefined): string {
  if (!usage) return "Chưa có usage.";
  if (usage.error) return `Lỗi: ${usage.error}`;
  const used = formatNumber(usage.usage);
  const limit = formatNumber(usage.limit);
  if (used && limit) return `${used} / ${limit}`;
  if (used) return used;
  return "Usage chưa có dữ liệu số.";
}

function formatUsageMeta(usage: AppState["usageCache"][string] | undefined): string {
  if (!usage || usage.error) return "";
  const parts = [];
  if (typeof usage.percent === "number") parts.push(`${Math.round(usage.percent)}%`);
  if (usage.refreshText) parts.push(usage.refreshText);
  if (usage.resetAt) parts.push(`reset ${new Date(usage.resetAt).toLocaleString("vi-VN")}`);
  parts.push(`updated ${new Date(usage.updatedAt).toLocaleTimeString("vi-VN")}`);
  return parts.join(" · ");
}

function formatNumber(value?: number): string {
  return typeof value === "number" ? Number(value.toFixed(4)).toString() : "";
}

function configSnapshot(state: AppState): string {
  return JSON.stringify({ providers: state.providers, activeProviderId: state.activeProviderId, preferences: state.preferences, glossary: state.glossary });
}
