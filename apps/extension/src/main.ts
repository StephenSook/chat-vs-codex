import type { PublicRoundState } from "../../../packages/round/src/public-state.js";
import { startPanelLifecycle } from "./lifecycle.js";
import { connectPanel, type ExtensionHelper, panelView } from "./panel.js";
import "./style.css";

declare global {
  interface Window {
    Twitch?: { ext: ExtensionHelper };
  }
}
let latest: PublicRoundState | null = null;
const draw = () => {
  const view = panelView(latest, Date.now());
  for (const [id, text] of Object.entries(view)) {
    const element = document.getElementById(
      id === "label" ? "round-label" : id,
    );
    if (element) element.textContent = text;
  }
};
const disconnect = window.Twitch
  ? connectPanel(window.Twitch.ext, (state) => {
      latest = state;
      draw();
    })
  : () => {};
// Only the clock and connection freshness change between measured snapshots.
startPanelLifecycle({
  page: window,
  draw,
  visible: () => !document.hidden,
  disconnect,
});
