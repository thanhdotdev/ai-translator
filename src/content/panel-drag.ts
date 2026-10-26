export interface PanelPosition { x: number; y: number }
export function clampPanelPosition(position: PanelPosition, panel: { width: number; height: number }, viewport: { width: number; height: number }, margin = 12): PanelPosition {
  return { x: Math.max(margin, Math.min(position.x, Math.max(margin, viewport.width - panel.width - margin))), y: Math.max(margin, Math.min(position.y, Math.max(margin, viewport.height - panel.height - margin))) };
}

export function enablePanelDrag(handle: HTMLElement, panel: HTMLElement, onMove: (position: PanelPosition) => void): () => void {
  let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
  function move(position: PanelPosition) {
    const next = clampPanelPosition(position, panel.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    onMove(next); panel.style.left = `${next.x}px`; panel.style.top = `${next.y}px`;
  }
  function down(event: PointerEvent) {
    if (event.button !== 0 || (event.target as Element).closest('button,a,input,select,textarea')) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture(event.pointerId); handle.dataset.dragging = "true";
  }
  function pointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    move({ x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y });
  }
  function up(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null; delete handle.dataset.dragging;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }
  function keyDown(event: KeyboardEvent) {
    if (event.target !== handle || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const rect = panel.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
    move({ x: rect.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: rect.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) });
  }
  handle.addEventListener("pointerdown", down);
  handle.addEventListener("pointermove", pointerMove);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
  handle.addEventListener("keydown", keyDown);
  return () => {
    if (drag && handle.hasPointerCapture(drag.id)) handle.releasePointerCapture(drag.id);
    delete handle.dataset.dragging;
    handle.removeEventListener("pointerdown", down); handle.removeEventListener("pointermove", pointerMove);
    handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up); handle.removeEventListener("keydown", keyDown);
  };
}
