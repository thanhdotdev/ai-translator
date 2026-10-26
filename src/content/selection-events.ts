/** Capture before page handlers; selectionchange also covers keyboard and touch. */
export function watchSelectionEvents(callbacks: {
  isInside: (event: Event) => boolean;
  onSelect: () => void;
  onOutsidePointer: () => void;
}, targets: { window: EventTarget; document: EventTarget } = { window, document }): () => void {
  let dragging = false;
  const listeners: Array<[EventTarget, string, EventListener]> = [];
  function listen(target: EventTarget, type: string, handler: EventListener) {
    target.addEventListener(type, handler, true);
    listeners.push([target, type, handler]);
  }
  listen(targets.window, "pointerdown", event => {
    if (callbacks.isInside(event)) return;
    dragging = (event as PointerEvent).button === 0;
    callbacks.onOutsidePointer();
  });
  for (const name of ["pointerup", "mouseup"]) listen(targets.window, name, event => {
    if (callbacks.isInside(event)) return;
    dragging = false;
    if ((event as MouseEvent).button === 0) callbacks.onSelect();
  });
  listen(targets.document, "selectionchange", () => { if (!dragging) callbacks.onSelect(); });
  listen(targets.window, "keyup", event => {
    if (callbacks.isInside(event)) return;
    const key = event as KeyboardEvent;
    if (key.key === "Shift" || key.key.startsWith("Arrow") || ((key.ctrlKey || key.metaKey) && key.key.toLowerCase() === "a")) callbacks.onSelect();
  });
  return () => { for (const [target, name, handler] of listeners) target.removeEventListener(name, handler, { capture: true }); };
}
