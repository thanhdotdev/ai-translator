import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { ExternalLink, RotateCcw, Square, Volume2, X } from "lucide-react";
import type { PronunciationResponse, RuntimeMessage } from "../shared/types";

import { accentLanguages, chooseAccentVoices, cambridgeLookupUrl, type Accent } from "./pronunciation-voices";
function PronunciationBody({ text }: { text: string }) {
  const [data, setData] = useState<PronunciationResponse | null>(null);
  const [playing, setPlaying] = useState<Accent | null>(null);
  const [error, setError] = useState("");
  const [voices, setVoices] = useState<Partial<Record<Accent, SpeechSynthesisVoice>>>({});
  const [failedAudio, setFailedAudio] = useState<Partial<Record<Accent, boolean>>>({});
  const [lookupVersion, setLookupVersion] = useState(0);
  const cambridgeUrl = cambridgeLookupUrl(text);
  const audio = useRef<HTMLAudioElement | null>(null);
  const speech = useRef<SpeechSynthesisUtterance | null>(null);
  const generation = useRef(0);
  const synth = typeof window.speechSynthesis === "undefined" ? null : window.speechSynthesis;
  function stop() {
    generation.current++;
    if (audio.current) { audio.current.pause(); audio.current.src = ""; audio.current = null; }
    if (speech.current) { speech.current = null; synth?.cancel(); }
  }
  useEffect(() => {
    let disposed = false;

    void chrome.runtime.sendMessage({ type: "GET_PRONUNCIATION", text } satisfies RuntimeMessage).then((response: PronunciationResponse) => {
      if (!disposed) setData(response?.accents ? response : { ok: false, accents: {} });
    }).catch(() => { if (!disposed) setData({ ok: false, accents: {} }); });
    return () => { disposed = true; stop(); };
  }, [text, lookupVersion]);
  useEffect(() => {
    if (!synth) return;
    const update = () => setVoices(chooseAccentVoices(synth.getVoices()));
    update(); synth.addEventListener("voiceschanged", update);
    return () => synth.removeEventListener("voiceschanged", update);
  }, [synth]);
  function speak(accent: Accent, token: number) {
    if (token !== generation.current) return;
    const voice = chooseAccentVoices(synth?.getVoices() || [])[accent];
    if (!synth || !voice) {
      setPlaying(null); setError(`Máy chưa có giọng ${accent === "US" ? "Anh–Mỹ" : "Anh–Anh"}. Hãy cài giọng tiếng Anh tương ứng trong cài đặt giọng nói của máy.`); return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    speech.current = utterance; utterance.lang = accentLanguages[accent]; utterance.voice = voice; utterance.rate = 0.9;
    utterance.onend = () => { if (token === generation.current) { speech.current = null; setPlaying(null); } };
    utterance.onerror = () => { if (token === generation.current) { speech.current = null; setPlaying(null); setError("Chưa phát được âm thanh. Bấm loa để thử lại."); } };
    try { synth.speak(utterance); } catch { speech.current = null; setPlaying(null); setError("Trình duyệt chưa phát được giọng đọc."); }
  }
  async function play(accent: Accent) {
    const previous = playing;
    stop(); setPlaying(null); setError("");
    if (previous === accent) return;
    const token = generation.current;
    setPlaying(accent);
    const url = failedAudio[accent] ? undefined : data?.accents[accent]?.audio;
    if (!url) { speak(accent, token); return; }
    const player = new Audio(url); audio.current = player;
    player.onended = () => { if (token === generation.current) { audio.current = null; setPlaying(null); } };
    const fallback = () => {
      if (token !== generation.current) return;
      audio.current = null; player.onerror = null; player.pause();
      setFailedAudio(previous => ({ ...previous, [accent]: true }));
      if (chooseAccentVoices(synth?.getVoices() || [])[accent]) {
        setError("Âm từ điển chưa phát được; đang dùng giọng máy, không phải bản thu từ điển."); speak(accent, token);
      } else { setPlaying(null); setError("Âm từ điển chưa phát được và máy chưa có giọng tương ứng. Bạn có thể nghe tại Cambridge."); }
    };
    player.onerror = fallback;
    try { await player.play(); } catch { if (token === generation.current && audio.current === player) { fallback(); } }
  }
  return <div className="avt-pronunciation" aria-label="Phát âm tiếng Anh">
    {(["US", "UK"] as const).map(accent => {
      const dictionaryAudio = failedAudio[accent] ? undefined : data?.accents[accent]?.audio;
      const voice = voices[accent];
      const source = dictionaryAudio ? "Âm từ điển" : voice ? `Giọng máy · ${voice.name}` : "Máy chưa có giọng này";
      return <div className="avt-pronunciation-row" key={accent}>
        <span className="avt-accent" title={accent === "US" ? "Anh–Mỹ" : "Anh–Anh"}>{accent}</span>
        <button type="button" disabled={!dictionaryAudio && !voice} aria-label={playing === accent ? `Dừng phát âm ${accent}` : `Nghe phát âm ${accent}`} title={`${accent === "US" ? "Anh–Mỹ" : "Anh–Anh"} · ${source}`} onClick={() => void play(accent)}>{playing === accent ? <Square size={12}/> : <Volume2 size={15}/>}</button>
        <div className="avt-pronunciation-detail"><span className={(data?.accents[accent]?.ipa || data?.genericIpa) ? "avt-ipa" : "avt-ipa-missing"}>{data?.accents[accent]?.ipa || data?.genericIpa || (!data ? "Đang tra IPA…" : data.sentence ? "Nghe đoạn gốc" : !data.ok ? "Chưa tải được IPA" : "Chưa có IPA riêng")}</span><small>{!data?.accents[accent]?.ipa && data?.genericIpa ? "IPA chung · " : ""}{source}</small></div>
        {data?.accents[accent]?.sourceUrl && <a className="avt-pronunciation-source" href={data.accents[accent]!.sourceUrl} target="_blank" rel="noreferrer" title={`${dictionaryAudio ? "Nguồn âm thanh" : "Nguồn IPA"} · ${data.accents[accent]!.license || "Xem giấy phép tại nguồn"}`}>Nguồn</a>}
      </div>;
    })}
    {data?.genericIpa && <div className="avt-ipa-generic">IPA chung: nguồn chưa ghi phiên âm riêng US/UK.</div>}
    {data?.sourceUrl && <a className="avt-pronunciation-source" href={data.sourceUrl} target="_blank" rel="noreferrer">{data.sourceName || "Wiktionary"} · IPA</a>}
    {cambridgeUrl && <a className="avt-cambridge-link" href={cambridgeUrl} target="_blank" rel="noreferrer">Nghe US/UK và xem IPA trên Cambridge <ExternalLink size={11}/></a>}
    {data && !data.ok && <button type="button" className="avt-pronunciation-retry" onClick={() => { stop(); setPlaying(null); setError(""); setData(null); setFailedAudio({}); setLookupVersion(value => value + 1); }}><RotateCcw size={12}/>Tra IPA lại</button>}
    {(error || data?.error) && <div className="avt-pronunciation-error" role="status">{error || data?.error}</div>}
  </div>;
}


// Keep audio controls outside the original text's reading and scrolling area.
export function Pronunciation({ text, portal }: { text: string; portal: HTMLElement }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  function close(restoreFocus = false) { setOpen(false); if (restoreFocus) trigger.current?.focus(); }
  useEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    let disposed = false;
    const button = trigger.current, popup = panel.current;
    const update = () => {
      void computePosition(button, popup, { strategy: "fixed", placement: "bottom-start", middleware: [offset(7), flip({ padding: 12 }), shift({ padding: 12 })] }).then(({x,y}) => {
        if (!disposed) Object.assign(popup.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      });
    };
    const cleanup = autoUpdate(button, popup, update);
    popup.querySelector<HTMLButtonElement>('.avt-pronunciation button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!event.composedPath().includes(button) && !event.composedPath().includes(popup)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(true); }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => { disposed = true; cleanup(); window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="avt-pronunciation-trigger" aria-label="Phát âm và phiên âm US/UK" title="Phát âm và phiên âm US/UK" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><Volume2 size={14}/></button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label="Phát âm và phiên âm" className="avt-pronunciation-popover">
      <div className="avt-pronunciation-heading"><strong>Phát âm</strong><button type="button" aria-label="Đóng phát âm" title="Đóng phát âm" onClick={() => close(true)}><X size={14}/></button></div>
      <PronunciationBody text={text}/>
    </div>, portal)}
  </>;
}
