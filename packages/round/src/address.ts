/** Shared by both runners and the exported OBS browser source. */
export const ROUND_PORT = 4317;
export const ROUND_ORIGIN = `http://127.0.0.1:${ROUND_PORT}`;
export const OVERLAY_URL = `${ROUND_ORIGIN}/?bridge=${encodeURIComponent(ROUND_ORIGIN)}`;
