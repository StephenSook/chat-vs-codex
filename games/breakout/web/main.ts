import {
  BRICK_H,
  BRICK_W,
  BRICKS,
  createState,
  HEIGHT,
  PADDLE_HALF,
  PADDLE_Y,
  Q,
  step,
  WIDTH,
} from "../src/index.js";
import "./style.css";

const canvasElement = document.querySelector("canvas");
const scoreElement = document.querySelector("#score");
if (!canvasElement || !scoreElement) throw new Error("Missing game surface");
const canvas = canvasElement;
const score = scoreElement;
const context = canvas.getContext("2d");
if (!context) throw new Error("Canvas unavailable");
const ctx = context;
let state = createState(13);
let input = 0;
let last = performance.now();
let debt = 0;
addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "Space"].includes(event.code))
    event.preventDefault();
  if (event.code === "ArrowLeft") input |= 1;
  if (event.code === "ArrowRight") input |= 2;
  if (event.code === "Space") input |= 4;
  if (event.code === "KeyR") state = createState(13);
});
addEventListener("keyup", (event) => {
  if (event.code === "ArrowLeft") input &= ~1;
  if (event.code === "ArrowRight") input &= ~2;
  if (event.code === "Space") input &= ~4;
});
addEventListener("blur", () => {
  input = 0;
});
function frame(now: number): void {
  debt += Math.min(100, now - last);
  last = now;
  while (debt >= 1000 / 60) {
    state = step(state, input);
    debt -= 1000 / 60;
  }
  ctx.setTransform(
    canvas.width / (WIDTH / Q),
    0,
    0,
    canvas.height / (HEIGHT / Q),
    0,
    0,
  );
  ctx.fillStyle = "#f6eee5";
  ctx.fillRect(0, 0, 480, 320);
  for (const brick of BRICKS)
    if (state.bricks & (1 << brick.id)) {
      const x = brick.x / Q,
        y = brick.y / Q,
        w = BRICK_W / Q,
        h = BRICK_H / Q;
      ctx.fillStyle = "#1F1D1B";
      ctx.fillRect(x + 3, y + 3, w, h);
      ctx.fillStyle = brick.id % 2 ? "#0477BD" : "#F7914E";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#fff8";
      ctx.fillRect(x + 4, y + 3, w - 8, 2);
    }
  ctx.fillStyle = "#1F1D1B";
  ctx.fillRect(
    (state.paddle - PADDLE_HALF) / Q + 3,
    PADDLE_Y / Q + 3,
    (PADDLE_HALF * 2) / Q,
    10,
  );
  ctx.fillStyle = "#0477BD";
  ctx.fillRect(
    (state.paddle - PADDLE_HALF) / Q,
    PADDLE_Y / Q,
    (PADDLE_HALF * 2) / Q,
    10,
  );
  ctx.beginPath();
  ctx.arc(state.x / Q + 2, state.y / Q + 2, 5, 0, 6.283185307179586);
  ctx.fillStyle = "#1F1D1B";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(state.x / Q, state.y / Q, 5, 0, 6.283185307179586);
  ctx.fillStyle = "#F7914E";
  ctx.fill();
  score.textContent = `${state.score} points${!state.alive ? " · R to restart" : state.won ? " · Clear!" : ""}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
