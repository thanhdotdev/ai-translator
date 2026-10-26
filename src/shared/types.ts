export type TonePreset = "simple" | "technical" | "natural";
export type TranslationMode = "full" | "quick";
export type QuotaSource = "none" | "localhost-proxy";

export type TermMode = "translate" | "keep";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  quotaSource?: QuotaSource;
  quotaAccountId?: string;
  quotaAccountName?: string;
  quotaModelPrefix?: string;
}

export interface ProxyQuotaAccount {
  id: string;
  name: string;
  label: string;
  modelPrefixes: string[];
  raw?: unknown;
}

export interface UsageCacheEntry {
  providerId: string;
  quotaAccountId: string;
  quotaAccountName?: string;
  usage?: number;
  limit?: number;
  remaining?: number;
  percent?: number;
  refreshText?: string;
  resetAt?: number;
  updatedAt: number;
  error?: string;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  mode: TermMode;
}

export interface Preferences {
  tone: TonePreset;
  translationMode: TranslationMode;
  customPrompt: string;
  showTermsByDefault: boolean;
  showFloatingButton: boolean;
  cacheEnabled: boolean;
  timeoutMs: number;
}

export interface TranslationTerm {
  source: string;
  meaning: string;
  note?: string;
}

export interface TranslationResult {
  detailsLoaded?: boolean;
  translation: string;
  explanation: string;
  terms: TranslationTerm[];
}

export interface HistoryItem {
  id: string;
  sourceText: string;
  result: TranslationResult;
  providerId: string;
  providerName: string;
  model: string;
  createdAt: number;
  context?: string;
  cacheKey?: string;
  detailsPrompt?: string;
  providerBaseUrl?: string;
}

export interface CacheEntry {
  id: string;
  sourceText: string;
  result: TranslationResult;
  providerId: string;
  model: string;
  promptHash: string;
  createdAt: number;
}

export interface AppState {
  providers: ProviderConfig[];
  activeProviderId: string;
  glossary: GlossaryTerm[];
  preferences: Preferences;
  history: HistoryItem[];
  cache: Record<string, CacheEntry>;
  proxyQuotaAccounts: ProxyQuotaAccount[];
  usageCache: Record<string, UsageCacheEntry>;
  lastTranslation?: TranslationResult;
}

export interface TranslateRequest {
  type: "TRANSLATE_SELECTION";
  text: string;
  context?: string;
}

export interface TranslateResponse {
  ok: boolean;
  historyId?: string;
  result?: TranslationResult;
  error?: string;
  cached?: boolean;
}

export interface AccentPronunciation {
  ipa?: string;
  audio?: string;
  sourceUrl?: string;
  license?: string;
  licenseUrl?: string;
}
export interface PronunciationResponse {
  ok: boolean;
  accents: Partial<Record<"US" | "UK", AccentPronunciation>>;
  genericIpa?: string;
  sourceName?: string;
  sourceUrl?: string;
  sentence?: boolean;
  error?: string;
}

export type RuntimeMessage =
  | TranslateRequest
  | { type: "GET_PRONUNCIATION"; text: string }
  | { type: "EXPLAIN_TRANSLATION"; historyId: string }
  | { type: "GET_STATE" }
  | { type: "SAVE_STATE"; state: Partial<AppState> }
  | { type: "TEST_PROVIDER"; provider: ProviderConfig }
  | { type: "SYNC_PROXY_QUOTA_ACCOUNTS"; provider: ProviderConfig }
  | { type: "DEBUG_PROXY_QUOTA_ACCOUNTS"; provider: ProviderConfig }
  | { type: "CHECK_LOCAL_PROXY_AUTH_COOKIE"; provider: ProviderConfig }
  | { type: "REFRESH_PROVIDER_USAGE"; providerId: string }
  | { type: "REFRESH_PROVIDER_USAGE_FOR_PROVIDER"; provider: ProviderConfig }
  | { type: "CLEAR_HISTORY" }
  | { type: "DELETE_HISTORY_ITEM"; id: string }
  | { type: "COPY_LAST_TRANSLATION" }
  | { type: "COMMAND_TRANSLATE_SELECTION" }
  | { type: "COMMAND_TOGGLE_RESULT" }
  | { type: "SHOW_TRANSLATION_FOR_TEXT"; text: string };

export type StreamPortRequest = {
  type: "TRANSLATE_STREAM";
  text: string;
  context?: string;
  translationMode?: TranslationMode;
};

export type StreamPortMessage =
  | { type: "STREAM_START" }
  | { type: "STREAM_CHUNK"; translation: string }
  | { type: "STREAM_EXPLANATION_START"; translation: string }
  | { type: "STREAM_DONE"; result: TranslationResult; cached?: boolean; historyId?: string }
  | { type: "STREAM_ERROR"; error: string };
