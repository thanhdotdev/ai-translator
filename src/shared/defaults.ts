import type { AppState, Preferences, ProviderConfig } from "./types";

export const OPENROUTER_PROVIDER_ID = "openrouter-default";

export const defaultProvider: ProviderConfig = {
  id: OPENROUTER_PROVIDER_ID,
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "",
  model: "openai/gpt-4o-mini",
  headers: {
    "HTTP-Referer": "https://local.extension",
    "X-Title": "AI Vietnamese Translator"
  }
};

export const defaultPreferences: Preferences = {
  tone: "simple",
  translationMode: "full",
  customPrompt: "",
  showTermsByDefault: true,
  showFloatingButton: true,
  cacheEnabled: true,
  timeoutMs: 45000
};

export const defaultState: AppState = {
  providers: [defaultProvider],
  activeProviderId: OPENROUTER_PROVIDER_ID,
  glossary: [],
  preferences: defaultPreferences,
  history: [],
  cache: {},
  proxyQuotaAccounts: [],
  usageCache: {}
};

export const toneLabels: Record<Preferences["tone"], string> = {
  simple: "Dễ hiểu",
  technical: "Kỹ thuật chính xác",
  natural: "Tự nhiên như người Việt"
};

export const translationModeLabels: Record<Preferences["translationMode"], string> = {
  full: "Dịch + giải thích",
  quick: "Dịch nhanh"
};
