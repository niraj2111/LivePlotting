import { createSaxiClient } from "../../shared/saxi-client.js";
import { strokesToSvg } from "../../shared/svg-mm.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const undoBtn = document.getElementById("undoBtn");
const clearBtn = document.getElementById("clearBtn");
const streamBtn = document.getElementById("streamBtn");
const autoStream = document.getElementById("autoStream");
const statusBadge = document.getElementById("statusBadge");
const paperBadge = document.getElementById("paperBadge");
const statusText = document.getElementById("statusText");

const strokes = [];
let currentStroke = null;
let paper = { x: 210, y: 297, marginMm: 20 };
let view = { scale: 1, offsetX: 0, offsetY: 0 };
let streamTimer = null;

const saxi = createSaxiClient({
  onStatus(text, connected) {
    statusText.textContent = text;
    statusBadge.textContent = `socket: ${connected ? "connected" : "disconnected"}`;
  },
  onPaper(nextPaper) {
    paper = nextPaper;
    paperBadge.textContent = `paper: ${paper.x} x ${paper.y} mm`;
    resizeCanvas();
    redraw();
  },
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.parentElement.clientWidth;
  const cssH = Math.max(420, window.innerHeight - 32);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const pad = 16 * dpr;
  const scale = Math.min((canvas.width - pad * 2) / paper.x, (canvas.height - pad * 2) / paper.y);
  view = {
    scale,
    offsetX: (canvas.width - paper.x * scale) / 2,
    offsetY: (canvas.height - paper.y * scale) / 2,
  };
}

function mmToPx(point) {
  return {
    x: view.offsetX + point.x * view.scale,
    y: view.offsetY + point.y * view.scale,
  };
}

function pxToMm(x, y) {
  return {
    x: clamp((x - view.offsetX) / view.scale, 0, paper.x),
    y: clamp((y - view.offsetY) / view.scale, 0, paper.y),
  };
}

function pointFromPointer(event) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  return pxToMm(x, y);
}

function drawGrid() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let x = 0; x <= paper.x; x += 5) {
    const a = mmToPx({ x, y: 0 });
    const b = mmToPx({ x, y: paper.y });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = x % 25 === 0 ? "#cad5e2" : "#e5ebf2";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (let y = 0; y <= paper.y; y += 5) {
    const a = mmToPx({ x: 0, y });
    const b = mmToPx({ x: paper.x, y });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = y % 25 === 0 ? "#cad5e2" : "#e5ebf2";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function redraw() {
  drawGrid();
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of strokes) {
    if (stroke.length < 2) continue;
    ctx.beginPath();
    const first = mmToPx(stroke[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.length; i += 1) {
      const point = mmToPx(stroke[i]);
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }
}

function queueAutoStream() {
  if (!autoStream.checked || streamTimer != null) return;
  streamTimer = window.setTimeout(() => {
    streamTimer = null;
    streamSvg();
  }, 120);
}

function streamSvg() {
  saxi.sendSvg(strokesToSvg(strokes, paper));
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  currentStroke = [pointFromPointer(event)];
  strokes.push(currentStroke);
  redraw();
});

canvas.addEventListener("pointermove", (event) => {
  if (!currentStroke) return;
  const point = pointFromPointer(event);
  const last = currentStroke[currentStroke.length - 1];
  if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 0.8) {
    currentStroke.push(point);
    redraw();
    queueAutoStream();
  }
});

canvas.addEventListener("pointerup", () => {
  currentStroke = null;
  if (autoStream.checked) {
    streamSvg();
  }
});

undoBtn.addEventListener("click", () => {
  strokes.pop();
  redraw();
});

clearBtn.addEventListener("click", () => {
  strokes.length = 0;
  redraw();
});

streamBtn.addEventListener("click", streamSvg);

window.addEventListener("resize", () => {
  resizeCanvas();
  redraw();
});

resizeCanvas();
redraw();
saxi.connect();
