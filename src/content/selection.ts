import type { VirtualElement } from "@floating-ui/dom";

const paragraphSelector = "p,li,blockquote,figcaption,td,th,h1,h2,h3,h4,h5,h6,pre";
export interface SelectedText {
  text: string;
  context?: string;
  paragraph?: HTMLElement;
  anchor: VirtualElement;
}

/** Use local prose only; never scrape the whole page or adjacent form fields. */
export function nearbyContext(paragraph: HTMLElement | undefined, sourceText: string): string {
  if (!paragraph) return "";
  const text = paragraph.innerText || paragraph.textContent || "";
  const index = text.indexOf(sourceText);
  const local = index >= 0 ? text.slice(Math.max(0, index - 650), index + sourceText.length + 650) : text.slice(0, 1600);
  function sibling(direction: "previousElementSibling" | "nextElementSibling") {
    let node = paragraph![direction];
    while (node?.hasAttribute("data-avt-bilingual")) node = node[direction];
    return node;
  }
  const siblings = [sibling("previousElementSibling"), sibling("nextElementSibling")];
  const adjacent = siblings.map(element => element?.matches(paragraphSelector) && !element.closest('[contenteditable="true"],form,nav,[data-avt-bilingual]') ? (element as HTMLElement).innerText?.trim().slice(0, 400) || "" : "");
  const context = [adjacent[0], local, adjacent[1]].filter(Boolean).join("\n\n").trim().slice(0, 2400);
  return context === sourceText.trim() ? "" : context;
}

export function paragraphForRange(range: Range): HTMLElement | undefined {
  const ancestor = range.commonAncestorContainer;
  const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
  const paragraph = element?.closest<HTMLElement>(paragraphSelector);
  if (!paragraph || paragraph.matches("td,th") || paragraph.closest('form,[contenteditable="true"],[data-avt-bilingual]')) return undefined;
  // A multi-paragraph selection has no single insertion target.
  return paragraph.contains(range.startContainer) && paragraph.contains(range.endContainer) ? paragraph : undefined;
}

export function selectParagraph(paragraph: HTMLElement): SelectedText {
  const text = (paragraph.innerText || paragraph.textContent || "").trim();
  return { text, context: nearbyContext(paragraph, text), paragraph, anchor: { contextElement: paragraph, getBoundingClientRect: () => paragraph.getBoundingClientRect() } };
}
