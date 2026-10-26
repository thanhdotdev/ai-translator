/** LI cannot host a ShadowRoot. Keep a list-item wrapper and attach to a DIV. */
export function createBilingualHost(paragraph: HTMLElement): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement(paragraph.tagName === "LI" ? "li" : "div");
  host.dataset.avtBilingual = "true";
  host.style.setProperty("display", "block", "important");
  host.style.setProperty("margin", "12px 0 18px", "important");
  let surface = host;
  if (host.tagName === "LI") {
    host.style.setProperty("list-style", "none", "important");
    host.setAttribute("role", "presentation");
    surface = document.createElement("div"); host.appendChild(surface);
  }
  return { host, shadow: surface.attachShadow({ mode: "open" }) };
}
