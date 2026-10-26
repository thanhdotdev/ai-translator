import { getPronunciation } from "./pronunciation";
import { buildQuickExplanationPrompt, buildQuickTranslationPrompt, buildSystemPrompt, buildTranslationInput, normalizeContext } from "../shared/prompt";
import { createId, getState, patchState, sha256, updateState } from "../shared/storage";
import type {
  AppState,
  HistoryItem,
  ProviderConfig,
  ProxyQuotaAccount,
  RuntimeMessage,
  StreamPortMessage,
  StreamPortRequest,
  TranslateResponse,
  TranslationMode,
  TranslationResult,
  UsageCacheEntry
} from "../shared/types";

chrome.runtime.onInstalled.addListener(async () => {
  await getState();
  chrome.contextMenus.create({
    id: "translate-selection",
    title: "Dịch bằng AI",
    contexts: ["selection"]
  });
  // Content-script declarations do not update pages already open in the browser.
  // Reinject on install/update, including unpacked-extension reloads.
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(tabs.filter(tab => typeof tab.id === "number").map(tab =>
    chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["content.js"] })
  ));
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translation-stream") return;

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message: StreamPortRequest) => {
    if (message.type !== "TRANSLATE_STREAM") return;
    translateSelectionStream(message.text, controller, port, message.translationMode, message.context).catch((error: unknown) => {
      postStream(port, {
        type: "STREAM_ERROR",
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "translate-selection") {
    await sendToTab(tab.id, { type: "COMMAND_TRANSLATE_SELECTION" });
  }
  if (command === "toggle-result") {
    await sendToTab(tab.id, { type: "COMMAND_TOGGLE_RESULT" });
  }
  if (command === "copy-last-translation") {
    await sendToTab(tab.id, { type: "COPY_LAST_TRANSLATION" });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "translate-selection" || !tab?.id || !info.selectionText) return;
  await sendToTab(tab.id, {
    type: "SHOW_TRANSLATION_FOR_TEXT",
    text: info.selectionText
  });
});

async function handleMessage(message: RuntimeMessage): Promise<unknown> {
  switch (message.type) {
    case "GET_STATE":
      return getState();
    case "SAVE_STATE":
      return patchState(message.state);
    case "TEST_PROVIDER":
      return testProvider(message.provider);
    case "SYNC_PROXY_QUOTA_ACCOUNTS":
      return syncProxyQuotaAccounts(message.provider);
    case "DEBUG_PROXY_QUOTA_ACCOUNTS":
      return debugProxyQuotaAccounts(message.provider);
    case "CHECK_LOCAL_PROXY_AUTH_COOKIE":
      return checkLocalProxyAuthCookie(message.provider);
    case "REFRESH_PROVIDER_USAGE":
      return refreshProviderUsageById(message.providerId);
    case "REFRESH_PROVIDER_USAGE_FOR_PROVIDER":
      return refreshProviderUsage(message.provider);
    case "CLEAR_HISTORY":
      return patchState({ history: [], cache: {}, lastTranslation: undefined });
    case "DELETE_HISTORY_ITEM": {
      return updateState(state => ({ history: state.history.filter((item) => item.id !== message.id) }));
    }
    case "GET_PRONUNCIATION":
      return getPronunciation(message.text);
    case "TRANSLATE_SELECTION":
      return performTranslation(message.text, { context: message.context });
    case "EXPLAIN_TRANSLATION":
      return explainTranslation(message.historyId);
    default:
      return { ok: false, error: "Unsupported message." };
  }
}

interface TranslationOptions {
  context?: string;
  translationMode?: TranslationMode;
  signal?: AbortSignal;
  onChunk?: (translation: string) => void;
}

async function performTranslation(text: string, options: TranslationOptions = {}): Promise<TranslateResponse> {
  const sourceText = text.trim();
  if (!sourceText) throw new Error("Không có văn bản để dịch.");
  const context = normalizeContext(options.context);
  const state = await getState();
  const provider = state.providers.find(item => item.id === state.activeProviderId);
  if (!provider) throw new Error("Chưa chọn nhà cung cấp AI.");
  if (!provider.apiKey.trim()) throw new Error(`Nhà cung cấp "${provider.name}" chưa có API key.`);
  if (!provider.model.trim()) throw new Error("Chưa chọn model AI.");
  const mode = options.translationMode ?? state.preferences.translationMode;
  const fullPrompt = buildSystemPrompt(state.preferences, state.glossary);
  const promptHash = await sha256(fullPrompt);
  const cacheKey = await sha256(["translation-v2", sourceText, context, provider.id, provider.baseUrl, provider.model, promptHash, mode].join("\n::\n"));
  const detailsPrompt = buildQuickExplanationPrompt(state.preferences, state.glossary);
  let result = state.preferences.cacheEnabled ? state.cache[cacheKey]?.result : undefined;
  const cached = Boolean(result);
  if (!result) {
    const input = buildTranslationInput(sourceText, context);
    if (mode === "quick") {
      let translation = "";
      await callChatCompletionsStream(provider, buildQuickTranslationPrompt(state.preferences, state.glossary), input, {
        signal: options.signal, timeoutMs: state.preferences.timeoutMs,
        onChunk(chunk) { translation += chunk; options.onChunk?.(translation); }
      });
      if (!translation.trim()) throw new Error("Nhà cung cấp không trả bản dịch. Vui lòng thử lại.");
      result = { translation: translation.trim(), explanation: "", terms: [], detailsLoaded: false };
    } else {
      result = { ...await callChatCompletions(provider, fullPrompt, input, { signal: options.signal, timeoutMs: state.preferences.timeoutMs }), detailsLoaded: true };
    }
  }
  options.signal?.throwIfAborted();
  const item = await saveHistoryAndLast(state, provider, sourceText, result, cacheKey, promptHash, context, detailsPrompt);
  return { ok: true, result, cached, historyId: item.id };
}

async function translateSelectionStream(text: string, controller: AbortController, port: chrome.runtime.Port, translationMode?: TranslationMode, context?: string): Promise<void> {
  postStream(port, { type: "STREAM_START" });
  const response = await performTranslation(text, { translationMode, context, signal: controller.signal, onChunk: translation => postStream(port, { type: "STREAM_CHUNK", translation }) });
  postStream(port, { type: "STREAM_DONE", result: response.result!, cached: response.cached, historyId: response.historyId });
}

async function saveHistoryAndLast(state: AppState, provider: ProviderConfig, sourceText: string, result: TranslationResult, cacheKey: string, promptHash: string, context: string, detailsPrompt: string): Promise<HistoryItem> {
  const item: HistoryItem = { id: createId("history"), sourceText, result, providerId: provider.id, providerName: provider.name, model: provider.model, createdAt: Date.now(), context, cacheKey, detailsPrompt, providerBaseUrl: provider.baseUrl };
  await updateState(current => ({
    lastTranslation: result,
    history: [item, ...current.history].slice(0, 100),
    cache: state.preferences.cacheEnabled ? { ...current.cache, [cacheKey]: { id: cacheKey, sourceText, result, providerId: provider.id, model: provider.model, promptHash, createdAt: Date.now() } } : current.cache
  }));
  if (provider.quotaAccountId) void refreshProviderUsage(provider).catch(() => undefined);
  return item;
}

const pendingExplanations = new Map<string, Promise<TranslateResponse>>();
function explainTranslation(historyId: string): Promise<TranslateResponse> {
  const pending = pendingExplanations.get(historyId);
  if (pending) return pending;
  const request = loadExplanation(historyId).finally(() => pendingExplanations.delete(historyId));
  pendingExplanations.set(historyId, request);
  return request;
}
async function loadExplanation(historyId: string): Promise<TranslateResponse> {
  const state = await getState();
  const item = state.history.find(entry => entry.id === historyId);
  if (!item) throw new Error("Bản dịch không còn trong lịch sử. Hãy dịch lại để lấy giải thích.");
  if (item.result.detailsLoaded !== false) return { ok: true, result: item.result, historyId, cached: true };
  const cached = item.cacheKey ? state.cache[item.cacheKey]?.result : undefined;
  let result: TranslationResult;
  if (state.preferences.cacheEnabled && cached?.detailsLoaded === true) result = cached;
  else {
    const configured = state.providers.find(provider => provider.id === item.providerId);
    if (!configured) throw new Error("Nhà cung cấp của bản dịch đã bị xóa. Hãy chọn nhà cung cấp khác và dịch lại.");
    if (item.providerBaseUrl && configured.baseUrl !== item.providerBaseUrl) throw new Error("Địa chỉ API đã thay đổi. Hãy dịch lại trước khi lấy giải thích.");
    const provider = { ...configured, model: item.model };
    const details = await callChatCompletions(provider, item.detailsPrompt || buildQuickExplanationPrompt(state.preferences, state.glossary), buildTranslationInput(item.sourceText, item.context, item.result.translation), { timeoutMs: state.preferences.timeoutMs });
    result = { ...item.result, explanation: details.explanation, terms: details.terms, detailsLoaded: true };
    if (provider.quotaAccountId) void refreshProviderUsage(provider).catch(() => undefined);
  }
  await updateState(current => ({
    // Do not recreate a record the user deleted while the request was running.
    history: current.history.map(entry => entry.id === historyId || (item.cacheKey && entry.cacheKey === item.cacheKey) ? { ...entry, result } : entry),
    cache: current.preferences.cacheEnabled && item.cacheKey && current.cache[item.cacheKey] ? { ...current.cache, [item.cacheKey]: { ...current.cache[item.cacheKey], result } } : current.cache,
    lastTranslation: current.history[0]?.id === historyId || (item.cacheKey && current.history[0]?.cacheKey === item.cacheKey) ? result : current.lastTranslation
  }));
  return { ok: true, result, historyId };
}

async function syncProxyQuotaAccounts(provider: ProviderConfig): Promise<{
  ok: boolean;
  accounts?: ProxyQuotaAccount[];
  preview?: string;
  error?: string;
}> {
  if (!isLocalhostProxyProvider(provider)) return { ok: false, error: "Provider này không phải localhost proxy." };
  try {
    const proxyOrigin = proxyOriginFor(provider);
    if (!proxyOrigin) return { ok: false, error: "Không đọc được origin của localhost proxy." };
    const response = await fetch(`${proxyOrigin}/api/providers/client?page=1&pageSize=20&accountStatus=all&sort=priority`, {
      credentials: "include",
      headers: await requestHeaders(provider, { preferCookieAuth: true })
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      return { ok: false, error: `Proxy trả lỗi ${response.status}: ${details.slice(0, 300) || response.statusText}` };
    }
    const data = await readJsonLike(response);
    const accounts = extractQuotaAccounts(data);
    await patchState({ proxyQuotaAccounts: accounts });
    return { ok: true, accounts, preview: previewPayload(data) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function debugProxyQuotaAccounts(provider: ProviderConfig): Promise<{ ok: boolean; preview?: string; error?: string }> {
  if (!isLocalhostProxyProvider(provider)) return { ok: false, error: "Provider này không phải localhost proxy." };
  try {
    const proxyOrigin = proxyOriginFor(provider);
    if (!proxyOrigin) return { ok: false, error: "Không đọc được origin của localhost proxy." };
    const response = await fetch(`${proxyOrigin}/api/providers/client?page=1&pageSize=20&accountStatus=all&sort=priority`, {
      credentials: "include",
      headers: await requestHeaders(provider, { preferCookieAuth: true })
    });
    const text = await response.text();
    return { ok: response.ok, preview: text.slice(0, 1800), error: response.ok ? undefined : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkLocalProxyAuthCookie(provider: ProviderConfig): Promise<{
  ok: boolean;
  found: boolean;
  checked: string[];
  source?: string;
  error?: string;
}> {
  if (!isLocalhostProxyProvider(provider)) {
    return { ok: false, found: false, checked: [], error: "Provider này không phải localhost proxy." };
  }
  const checked = localProxyCookieOrigins(provider);
  if (!(await hasCookiePermission())) return { ok: false, found: false, checked, error: "Chưa được phép dùng phiên đăng nhập proxy. Bật quyền cookie trong cài đặt tiện ích nếu bạn muốn sử dụng." };
  try {
    for (const origin of checked) {
      const cookie = await chrome.cookies.get({ url: origin, name: "auth_token" }).catch(() => null);
      if (cookie?.value) return { ok: true, found: true, checked, source: origin };
    }
    return { ok: true, found: false, checked };
  } catch (error) {
    return { ok: false, found: false, checked, error: error instanceof Error ? error.message : String(error) };
  }
}

async function refreshProviderUsageById(providerId: string): Promise<{ ok: boolean; usage?: UsageCacheEntry; error?: string }> {
  const state = await getState();
  const provider = state.providers.find((item) => item.id === providerId);
  if (!provider) return { ok: false, error: "Không tìm thấy provider." };
  return refreshProviderUsage(provider);
}

async function refreshProviderUsage(provider: ProviderConfig): Promise<{ ok: boolean; usage?: UsageCacheEntry; error?: string }> {
  if (!isLocalhostProxyProvider(provider)) return { ok: false, error: "Provider này không phải localhost proxy." };
  const accountId = provider.quotaAccountId;
  if (!accountId) return { ok: false, error: "Chưa chọn quota account." };

  try {
    const proxyOrigin = proxyOriginFor(provider);
    if (!proxyOrigin) throw new Error("Không đọc được origin của localhost proxy.");
    const response = await fetch(`${proxyOrigin}/api/usage/${accountId}`, {
      credentials: "include",
      headers: await requestHeaders(provider, { preferCookieAuth: true })
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Proxy usage trả lỗi ${response.status}: ${details.slice(0, 300) || response.statusText}`);
    }
    const data = await readJsonLike(response);
    const usage = normalizeUsage(data, provider);
    const state = await getState();
    await patchState({
      usageCache: {
        ...state.usageCache,
        [provider.id]: usage
      }
    });
    return { ok: true, usage };
  } catch (error) {
    const state = await getState();
    const usage: UsageCacheEntry = {
      providerId: provider.id,
      quotaAccountId: accountId,
      quotaAccountName: provider.quotaAccountName,
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error)
    };
    await patchState({
      usageCache: {
        ...state.usageCache,
        [provider.id]: usage
      }
    });
    return { ok: false, usage, error: usage.error };
  }
}

async function testProvider(provider: ProviderConfig): Promise<{ ok: boolean; error?: string }> {
  if (!provider.apiKey.trim()) return { ok: false, error: "API key đang trống." };
  if (!provider.baseUrl.trim()) return { ok: false, error: "Base URL đang trống." };
  if (!provider.model.trim()) return { ok: false, error: "Model đang trống." };

  try {
    await callChatCompletions(
      provider,
      "Return only valid JSON: {\"translation\":\"ok\",\"explanation\":\"ok\",\"terms\":[]}",
      "test",
      { timeoutMs: 20000 }
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function callChatCompletions(
  provider: ProviderConfig,
  systemPrompt: string,
  sourceText: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<TranslationResult> {
  const controller = createTimeoutController(options);
  const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: await requestHeaders(provider),
      body: JSON.stringify(chatBody(provider, systemPrompt, sourceText, false))
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Provider trả lỗi ${response.status}: ${details.slice(0, 300) || response.statusText}`);
    }

    const content = await readChatContent(response);
    if (!content) throw new Error("Provider không trả nội dung dịch.");

    return normalizeResult(parseModelJson(content));
  } finally {
    controller.clear();
  }
}

async function callChatCompletionsStream(
  provider: ProviderConfig,
  systemPrompt: string,
  sourceText: string,
  options: { signal?: AbortSignal; timeoutMs?: number; onChunk: (chunk: string) => void }
): Promise<void> {
  const controller = createTimeoutController(options);
  const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: await requestHeaders(provider),
      body: JSON.stringify(chatBody(provider, systemPrompt, sourceText, true))
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Provider trả lỗi ${response.status}: ${details.slice(0, 300) || response.statusText}`);
    }
    if (!response.body) throw new Error("Provider không hỗ trợ streaming response.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (chunk) options.onChunk(chunk);
      }
    }
  } finally {
    controller.clear();
  }
}

async function requestHeaders(
  provider: ProviderConfig,
  options: { preferCookieAuth?: boolean } = {}
): Promise<Record<string, string>> {
  const endpoint = new URL(provider.baseUrl);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
    throw new Error("Nhà cung cấp trên Internet cần dùng HTTPS để bảo vệ API key và nội dung dịch. HTTP chỉ hỗ trợ dịch vụ chạy trên máy này.");
  }
  const token = await resolveAuthToken(provider, options);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...cleanHeaders(provider.headers)
  };
}

async function resolveAuthToken(
  provider: ProviderConfig,
  options: { preferCookieAuth?: boolean } = {}
): Promise<string> {
  if (options.preferCookieAuth && isLocalhostProxyProvider(provider)) {
    const cookieToken = await readLocalProxyAuthToken(provider);
    if (cookieToken) return cookieToken;
  }
  return provider.apiKey;
}

async function hasCookiePermission(): Promise<boolean> {
  return Boolean(chrome.cookies?.get) && Boolean(await chrome.permissions?.contains({ permissions: ["cookies"] }).catch(() => false));
}

async function readLocalProxyAuthToken(provider: ProviderConfig): Promise<string | null> {
  if (!(await hasCookiePermission())) return null;
  const origins = localProxyCookieOrigins(provider);
  for (const origin of origins) {
    const cookie = await chrome.cookies.get({ url: origin, name: "auth_token" }).catch(() => null);
    if (cookie?.value) return cookie.value;
  }
  return null;
}

function localProxyCookieOrigins(provider: ProviderConfig): string[] {
  const origins = new Set<string>();
  try {
    const url = new URL(provider.baseUrl);
    origins.add(url.origin);
    if (url.hostname === "localhost") origins.add(`${url.protocol}//127.0.0.1:${url.port}`);
    if (url.hostname === "127.0.0.1") origins.add(`${url.protocol}//localhost:${url.port}`);
  } catch {
    origins.add("http://127.0.0.1:20128");
    origins.add("http://localhost:20128");
  }
  origins.add("http://127.0.0.1:20128");
  origins.add("http://localhost:20128");
  return [...origins];
}

function chatBody(provider: ProviderConfig, systemPrompt: string, sourceText: string, stream: boolean): object {
  return {
    model: provider.model,
    temperature: 0.2,
    stream,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: sourceText }
    ]
  };
}

async function readChatContent(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("text/event-stream") || text.trimStart().startsWith("data:")) {
    return readSseContent(text);
  }

  const payload = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content || payload.choices?.[0]?.delta?.content || "";
}

async function readJsonLike(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trimStart().startsWith("data:")) {
    const chunks = readSseJson(text);
    return chunks.at(-1) ?? {};
  }
  return JSON.parse(text);
}

function readSseJson(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    values.push(JSON.parse(payload));
  }
  return values;
}

function readSseContent(text: string): string {
  let content = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
    };
    content += parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || "";
  }
  return content;
}

function createTimeoutController(options: { signal?: AbortSignal; timeoutMs?: number }): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeoutMs = Math.max(5000, options.timeoutMs ?? 45000);
  const timeoutId = globalThis.setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);
  options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
  return {
    signal: controller.signal,
    clear: () => globalThis.clearTimeout(timeoutId)
  };
}

function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Không đọc được JSON từ phản hồi AI.");
    return JSON.parse(match[0]);
  }
}

function normalizeResult(value: unknown): TranslationResult {
  const data = value as Partial<TranslationResult>;
  return {
    translation: typeof data.translation === "string" ? data.translation : "",
    explanation: typeof data.explanation === "string" ? data.explanation : "",
    terms: Array.isArray(data.terms)
      ? data.terms
          .filter((term) => term && typeof term === "object")
          .map((term) => {
            const item = term as unknown as Record<string, unknown>;
            return {
              source: String(item.source ?? ""),
              meaning: String(item.meaning ?? ""),
              note: item.note ? String(item.note) : undefined
            };
          })
          .filter((term) => term.source || term.meaning)
      : []
  };
}

function cleanHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) => key.trim() && value.trim()));
}

function isLocalhostProxyProvider(provider: ProviderConfig): boolean {
  return Boolean(proxyOriginFor(provider));
}

function proxyOriginFor(provider: ProviderConfig): string | null {
  try {
    const url = new URL(provider.baseUrl);
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === "20128") {
      return "http://127.0.0.1:20128";
    }
    return null;
  } catch {
    return null;
  }
}

function extractQuotaAccounts(payload: unknown): ProxyQuotaAccount[] {
  const directItems = findArrayPayload(payload);
  const deepItems = findObjectArraysDeep(payload).flat();
  const items = directItems.length ? directItems : deepItems;
  const accounts = items
    .map((item) => normalizeQuotaAccount(item))
    .filter((account): account is ProxyQuotaAccount => Boolean(account));
  return [...new Map(accounts.map((account) => [account.id, account])).values()];
}

function findArrayPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates = [record.connections, record.data, record.items, record.list, record.rows, record.providers, record.accounts];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = findArrayPayload(candidate);
      if (nested.length) return nested;
    }
  }
  return [];
}

function findObjectArraysDeep(payload: unknown, depth = 0): unknown[][] {
  if (depth > 8 || !payload || typeof payload !== "object") return [];
  if (Array.isArray(payload)) {
    const objectCount = payload.filter((item) => item && typeof item === "object").length;
    const nested = payload.flatMap((item) => findObjectArraysDeep(item, depth + 1));
    return objectCount ? [payload, ...nested] : nested;
  }
  return Object.values(payload as Record<string, unknown>).flatMap((value) => findObjectArraysDeep(value, depth + 1));
}

function normalizeQuotaAccount(item: unknown): ProxyQuotaAccount | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const id = firstString(record, ["id", "_id", "uuid", "accountId", "providerId", "clientId", "key"]);
  if (!id) return null;
  const providerName = firstString(record, ["provider", "providerName"]);
  const accountName = firstString(record, ["name", "accountName", "displayName", "title"]) || id;
  const name = providerName ? titleCase(providerName) : accountName;
  const label = firstString(record, ["label", "email", "code", "slug"]) || accountName;
  const modelPrefixes = [
    ...providerPrefixHints(providerName),
    ...stringList(record.modelPrefixes),
    ...stringList(record.prefixes),
    ...stringList(record.models),
    ...stringList(record.model),
    ...stringList(record.slug),
    ...stringList(record.code)
  ].map((value) => value.split("/")[0]).filter(Boolean);

  return {
    id,
    name,
    label,
    modelPrefixes: [...new Set(modelPrefixes)],
    raw: item
  };
}

function providerPrefixHints(provider?: string): string[] {
  if (!provider) return [];
  const normalized = provider.toLowerCase();
  return [normalized, normalized.slice(0, 2)].filter(Boolean);
}

function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function previewPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2).slice(0, 1800);
  } catch {
    return String(payload).slice(0, 1800);
  }
}

function normalizeUsage(payload: unknown, provider: ProviderConfig): UsageCacheEntry {
  const record = findObjectWithUsage(payload);
  const usage = firstNumber(record, ["usage", "used", "current", "value", "consumed", "totalUsed"]);
  const limit = firstNumber(record, ["limit", "quota", "max", "total", "capacity"]);
  const remaining = firstNumber(record, ["remaining", "left", "available"]);
  const percent = firstNumber(record, ["percent", "percentage", "ratio"]) ?? calculatePercent(usage, limit, remaining);
  const refreshText = firstString(record, ["refreshText", "resetText", "expiresIn", "timeLeft", "remainingTime"]);
  const resetAtValue = firstNumber(record, ["resetAt", "refreshAt", "expiresAt"]) ?? firstString(record, ["resetAt", "refreshAt", "expiresAt"]);

  return {
    providerId: provider.id,
    quotaAccountId: provider.quotaAccountId || "",
    quotaAccountName: provider.quotaAccountName,
    usage,
    limit,
    remaining,
    percent,
    refreshText,
    resetAt: normalizeDateValue(resetAtValue),
    updatedAt: Date.now()
  };
}

function findObjectWithUsage(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  // Current proxy responses keep the primary quota under quotas.session.
  // Prefer it over other credit balances or quota windows in the response.
  const quotas = record.quotas;
  if (quotas && typeof quotas === "object") {
    const session = findObjectWithUsage((quotas as Record<string, unknown>).session);
    if (Object.keys(session).length) return session;
  }
  if (firstNumber(record, [
    "usage", "used", "current", "value", "consumed", "totalUsed",
    "limit", "quota", "max", "total", "capacity",
    "remaining", "left", "available", "percent", "percentage", "ratio"
  ]) !== undefined) return record;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findObjectWithUsage(item);
        if (Object.keys(found).length) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findObjectWithUsage(value);
      if (Object.keys(found).length) return found;
    }
  }
  // Metadata-only objects must not stop the search through sibling objects.
  return {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap((item) => stringList(item));
  return [];
}

function calculatePercent(usage?: number, limit?: number, remaining?: number): number | undefined {
  if (typeof usage === "number" && typeof limit === "number" && limit > 0) return Math.max(0, Math.min(100, (usage / limit) * 100));
  if (typeof remaining === "number" && typeof limit === "number" && limit > 0) return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  return undefined;
}

function normalizeDateValue(value: unknown): number | undefined {
  if (typeof value === "number") return value > 1_000_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  return undefined;
}

async function sendToTab(tabId: number, message: RuntimeMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    await chrome.tabs.sendMessage(tabId, message);
  }
}

function postStream(port: chrome.runtime.Port, message: StreamPortMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // The user may close the tab or cancel while the provider request is finishing.
  }
}
