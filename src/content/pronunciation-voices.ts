export type Accent = "US" | "UK";
export const accentLanguages = { US: "en-US", UK: "en-GB" };
interface Voice { lang: string; name: string; voiceURI: string }
export function chooseAccentVoices<T extends Voice>(voices: T[]): Partial<Record<Accent, T>> {
  const result: Partial<Record<Accent, T>> = {};
  for (const accent of ["US", "UK"] as const) {
    const other = accent === "UK" ? result.US : undefined;
    result[accent] = voices.filter(voice =>
      voice.lang.replace(/_/g, "-").toLowerCase() === accentLanguages[accent].toLowerCase()
      && (!other || (voice.voiceURI && voice.voiceURI !== other.voiceURI))
    ).sort((a,b) => score(b) - score(a))[0];
  }
  return result;
}
function score(voice: Voice): number {
  return /natural|neural/i.test(voice.name) ? 3 : /google|samantha|daniel|serena|alex/i.test(voice.name) ? 2 : 0;
}
export function cambridgeLookupUrl(text: string): string | null {
  const term = text.trim().toLowerCase().replace(/’/g, "'");
  if (term.length > 80 || !/^[a-z]+(?:[-' ][a-z]+){0,2}$/.test(term)) return null;
  return `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(term.replace(/ /g, "-"))}`;
}
