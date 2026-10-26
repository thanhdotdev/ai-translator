import { defaultState } from "./defaults";
import type { AppState } from "./types";

const STORAGE_KEY = "aiVietnameseTranslatorState";

export async function getState(): Promise<AppState> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const stored = data[STORAGE_KEY] as Partial<AppState> | undefined;
  return {
    ...defaultState,
    ...stored,
    preferences: {
      ...defaultState.preferences,
      ...stored?.preferences
    },
    providers: stored?.providers?.length ? stored.providers : defaultState.providers,
    glossary: stored?.glossary ?? [],
    history: stored?.history ?? [],
    cache: stored?.cache ?? {},
    proxyQuotaAccounts: stored?.proxyQuotaAccounts ?? [],
    usageCache: stored?.usageCache ?? {}
  };
}

export async function setState(next: AppState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

// Serialize read/modify/write operations so simultaneous paragraph translations
// and lazy explanations cannot overwrite each other's history or cache entries.
let pendingWrite: Promise<unknown> = Promise.resolve();
export function updateState(update: (current: AppState) => Partial<AppState>): Promise<AppState> {
  const write = pendingWrite.then(async () => {
    const current = await getState();
    const patch = update(current);
    const next: AppState = { ...current, ...patch, preferences: { ...current.preferences, ...patch.preferences } };
    await setState(next);
    return next;
  });
  pendingWrite = write.catch(() => undefined);
  return write;
}

export function patchState(patch: Partial<AppState>): Promise<AppState> {
  return updateState(() => patch);
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
