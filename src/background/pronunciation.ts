import { parseDocument, DomUtils } from "htmlparser2";
import type { Element, AnyNode } from "domhandler";
import type { AccentPronunciation, PronunciationResponse } from "../shared/types";

type Accent = "US" | "UK";
const cache = new Map<string, { expires: number; value: PronunciationResponse }>();
const pending = new Map<string, Promise<PronunciationResponse>>();
export function dictionaryTerm(text: string): string | null {
  const term = text.trim().toLowerCase().replace(/’/g, "'");
  return term.length <= 80 && /^[a-z]+(?:[-' ][a-z]+){0,2}$/.test(term) ? term : null;
}
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return url.protocol === "https:" && url.hostname === "upload.wikimedia.org" ? url.href : undefined;
  } catch { return; }
}
function ipa(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  return text.length <= 180 && /^(\/[^\n]+\/|\[[^\n]+\])$/.test(text) ? text : undefined;
}
function accents(label: string): Accent[] {
  const result: Accent[] = [];
  if (/\b(?:US|USA|General[- ]American|American(?: English)?)\b/i.test(label)) result.push("US");
  if (/\b(?:UK|GB|RP|Received[- ]Pronunciation|General[- ]British|British(?: English)?)\b/i.test(label)) result.push("UK");
  return result;
}
function audioAccents(file: string): Accent[] {
  return /(?:[-_]us)(?:[-_.]|$)/i.test(file) ? ["US"] : /(?:[-_](?:uk|gb))(?:[-_.]|$)/i.test(file) ? ["UK"] : [];
}
function empty(term: string): PronunciationResponse {
  return { ok: true, accents: {}, sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(term)}#English`, sourceName: "Wiktionary" };
}
function add(result: PronunciationResponse, accent: Accent, value: AccentPronunciation) {
  const current = result.accents[accent] || {};
  result.accents[accent] = { ...current, ipa: current.ipa || value.ipa, audio: current.audio || value.audio, sourceUrl: !current.audio && value.audio ? value.sourceUrl : current.sourceUrl || value.sourceUrl, license: current.license || value.license, licenseUrl: current.licenseUrl || value.licenseUrl };
}
function hasData(result: PronunciationResponse): boolean {
  return !!result.genericIpa || Object.values(result.accents).some(value => value?.ipa || value?.audio);
}
export function parseWiktApi(data: unknown, term: string): PronunciationResponse {
  const result = empty(term);
  if (!data || typeof data !== "object" || !Array.isArray((data as { entries?: unknown }).entries)) return { ...result, ok: false };
  let generic: string | undefined;
  for (const entry of (data as { entries: any[] }).entries) {
    if (!entry || (entry.lang_code && entry.lang_code !== "en")) continue;
    for (const sound of Array.isArray(entry.sounds) ? entry.sounds : []) {
      if (!sound || typeof sound !== "object") continue;
      const text = ipa(sound.ipa);
      const audio = safeUrl(sound.mp3_url) || safeUrl(sound.ogg_url);
      const tags = Array.isArray(sound.tags) ? sound.tags.filter((tag: unknown) => typeof tag === "string").join(" ") : "";
      const regions = accents(tags);
      if (!regions.length && typeof sound.audio === "string") regions.push(...audioAccents(sound.audio));
      const sourceUrl = typeof sound.audio === "string" && audio ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(sound.audio)}` : result.sourceUrl;
      for (const region of regions) if (text || audio) add(result, region, { ipa: text, audio, sourceUrl });
      if (!regions.length && text && !sound.note) generic ||= text;
    }
  }
  if (!result.accents.US?.ipa && !result.accents.UK?.ipa) result.genericIpa = generic;
  result.sourceName = "WiktAPI · Wiktionary";
  return result;
}
function hasClass(node: Element, name: string): boolean { return (node.attribs.class || "").split(/\s+/).includes(name); }
function ancestor(node: AnyNode, predicate: (element: Element) => boolean): Element | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if ("name" in parent && predicate(parent)) return parent;
}
function labelFor(node: Element): string {
  let item = ancestor(node, element => element.name === "li");
  while (item) {
    const current = item;
    const labels = DomUtils.findAll(element => (hasClass(element,"qualifier-content") || hasClass(element,"usage-label-accent")) && ancestor(element, parent => parent.name === "li") === current, current.children);
    const label = labels.map(element => DomUtils.textContent(element)).join(" ");
    if (accents(label).length) return label;
    item = ancestor(current, element => element.name === "li");
  }
  return "";
}
export function parseWiktionaryHtml(html: string, term: string): PronunciationResponse {
  const result = empty(term);
  const document = parseDocument(html);
  const elements = DomUtils.findAll(() => true, document.children);
  let english = false, level = 0;
  let generic: string | undefined;
  for (const element of elements) {
    if (element.name === "h2") { english = element.attribs.id === "English" || DomUtils.textContent(element).trim() === "English"; level = 0; }
    if (!english) continue;
    if (/^h[3-6]$/.test(element.name)) {
      const depth = Number(element.name[1]);
      if (/^Pronunciation(?:_\d+)?$/.test(element.attribs.id || "")) level = depth;
      else if (level && depth <= level) level = 0;
    }
    if (!level) continue;
    if (hasClass(element,"IPA") && !ancestor(element,parent => hasClass(parent,"qualifier-content") || hasClass(parent,"usage-label-accent"))) {
      const text = ipa(DomUtils.textContent(element));
      if (!text) continue;
      const regions = accents(labelFor(element));
      if (regions.length) for (const region of regions) add(result,region,{ipa:text,sourceUrl:result.sourceUrl});
      else generic ||= text;
    }
    if (element.name === "audio") {
      const sources = DomUtils.findAll(child => child.name === "source", element.children);
      const audio = sources.map(source => ({ url:safeUrl(source.attribs.src), mp3:source.attribs.type === "audio/mpeg" })).filter(source => source.url).sort((a,b)=>Number(b.mp3)-Number(a.mp3))[0]?.url;
      if (!audio) continue;
      const table = ancestor(element,parent=>hasClass(parent,"audiotable"));
      const regions = accents(table ? DomUtils.textContent(table) : labelFor(element));
      const file = element.attribs["data-mwtitle"] || "";
      if (!regions.length) regions.push(...audioAccents(file));
      for (const region of regions) add(result,region,{audio,sourceUrl:file ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}` : result.sourceUrl});
    }
  }
  if (!result.accents.US?.ipa && !result.accents.UK?.ipa) result.genericIpa = generic;
  return result;
}
function merge(primary: PronunciationResponse, fallback: PronunciationResponse): PronunciationResponse {
  const result = { ...primary, accents: { ...primary.accents }, genericIpa: primary.genericIpa || fallback.genericIpa, ok: true };
  for (const accent of ["US","UK"] as const) if (fallback.accents[accent]) add(result,accent,fallback.accents[accent]!);
  if (!hasData(primary)) result.sourceName = fallback.sourceName;
  return result;
}
async function fetchJson(url: string, timeout: number): Promise<any> {
  const response = await fetch(url,{credentials:"omit",signal:AbortSignal.timeout(timeout)});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
export async function getPronunciation(text: string): Promise<PronunciationResponse> {
  const term = dictionaryTerm(text);
  if (!term) return {ok:true,accents:{},sentence:true};
  const saved = cache.get(term);
  if (saved && saved.expires > Date.now()) return saved.value;
  if (pending.has(term)) return pending.get(term)!;
  const request = (async () => {
    let result = empty(term), success = false;
    try {
      try {
        const data = await fetchJson(`https://api.wiktapi.dev/v1/en/word/${encodeURIComponent(term)}?lang=en`,5000);
        const parsed = data ? parseWiktApi(data,term) : empty(term);
        if (parsed.ok) { result = parsed; success = true; }
      } catch { /* Try the independent Wiktionary endpoint below. */ }
      const complete = (["US","UK"] as const).every(accent => result.accents[accent]?.ipa && result.accents[accent]?.audio);
      if (!complete) try {
        const params = new URLSearchParams({action:"parse",page:term,prop:"text",format:"json",formatversion:"2",redirects:"1"});
        const data = await fetchJson(`https://en.wiktionary.org/w/api.php?${params}`,6000);
        if (data?.parse?.text && typeof data.parse.text === "string") { result=merge(result,parseWiktionaryHtml(data.parse.text,term)); success=true; }
        else if (data?.error?.code === "missingtitle") success = true;
      } catch { /* Keep valid data already obtained from WiktAPI. */ }
      if (!success) return {...result,ok:false,error:"Chưa kết nối được nguồn IPA. Bạn có thể tra lại hoặc mở từ điển."};
      if (cache.size>=100) cache.delete(cache.keys().next().value!);
      cache.set(term,{value:result,expires:Date.now()+(hasData(result)?30:5)*60*1000});
      return result;
    } finally { pending.delete(term); }
  })();
  pending.set(term,request);
  return request;
}
