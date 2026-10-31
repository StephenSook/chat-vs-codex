/** A restored BFCache page keeps its one helper subscription and resumes only its clock. */
export function startPanelLifecycle(options: {
  page: Pick<Window, "addEventListener" | "removeEventListener">;
  draw(): void;
  visible(): boolean;
  disconnect(): void;
}): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const refresh = () => {
    if (!closed && options.visible()) options.draw();
  };
  const pause = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const start = () => {
    if (!closed && timer === undefined) timer = setInterval(refresh, 250);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    pause();
    options.page.removeEventListener("pagehide", hide);
    options.page.removeEventListener("pageshow", show);
    options.disconnect();
  };
  const hide = (event: PageTransitionEvent) => {
    pause();
    if (!event.persisted) close();
  };
  const show = () => {
    start();
    refresh();
  };
  options.page.addEventListener("pagehide", hide);
  options.page.addEventListener("pageshow", show);
  start();
  refresh();
  return close;
}
