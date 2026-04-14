import "./stream-input.css";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const undoBtn = document.getElementById("undoBtn");
const clearBtn = document.getElementById("clearBtn");
const streamBtn = document.getElementById("streamBtn");
const autoStream = document.getElementById("autoStream");
const showGrid = document.getElementById("showGrid");
const snapGrid = document.getElementById("snapGrid");
const brushType = document.getElementById("brushType");
const roundSize = document.getElementById("roundSize");
const flatWidth = document.getElementById("flatWidth");
const flatAngle = document.getElementById("flatAngle");
const streamlineInput = document.getElementById("streamline");
const smoothingInput = document.getElementById("smoothing");
const minDistanceInput = document.getElementById("minDistance");
const roundRow = document.getElementById("roundRow");
const flatControls = document.getElementById("flatControls");
const roundSizeValue = document.getElementById("roundSizeValue");
const flatWidthValue = document.getElementById("flatWidthValue");
const flatAngleValue = document.getElementById("flatAngleValue");
const streamlineValue = document.getElementById("streamlineValue");
const smoothingValue = document.getElementById("smoothingValue");
const minDistanceValue = document.getElementById("minDistanceValue");
const connectionBadge = document.getElementById("connectionBadge");
const paperBadge = document.getElementById("paperBadge");
const brushBadge = document.getElementById("brushBadge");
const status = document.getElementById("status");

const strokes = [];
let current = null;
let socket = null;
let streamTimer = null;
let frameTimer = null;
let connected = false;
let paper = { x: 210, y: 297, marginMm: 20 };
let view = { scale: 1, offsetX: 0, offsetY: 0 };
const svgUnitsPerMm = 96 / 25.4;

function fmt(n) {
  return Number(n)
    .toFixed(3)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function brushSizeMm() {
  return brushType.value === "round" ? Number(roundSize.value) : Number(flatWidth.value);
}

function updateBadges() {
  connectionBadge.textContent = "socket: " + (connected ? "connected" : "disconnected");
  paperBadge.textContent =
    "paper: " + fmt(paper.x) + " x " + fmt(paper.y) + " mm, margin " + fmt(paper.marginMm) + " mm";
  if (brushType.value === "round") {
    brushBadge.textContent = "brush: round " + fmt(Number(roundSize.value)) + " mm";
  } else {
    brushBadge.textContent =
      "brush: flat " + fmt(Number(flatWidth.value)) + " mm @ " + fmt(Number(flatAngle.value)) + " deg";
  }
}

function updateControlLabels() {
  roundSizeValue.textContent = fmt(Number(roundSize.value)) + " mm";
  flatWidthValue.textContent = fmt(Number(flatWidth.value)) + " mm";
  flatAngleValue.textContent = fmt(Number(flatAngle.value)) + " deg";
  streamlineValue.textContent = fmt(Number(streamlineInput.value));
  smoothingValue.textContent = fmt(Number(smoothingInput.value));
  minDistanceValue.textContent = fmt(Number(minDistanceInput.value)) + " mm";
  const flat = brushType.value === "flat";
  flatControls.style.display = flat ? "" : "none";
  roundRow.style.display = flat ? "none" : "";
  updateBadges();
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(320, canvas.parentElement.clientWidth - 20);
  const cssH = cssW * (paper.y / paper.x);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const pad = 12 * dpr;
  const scale = Math.min((canvas.width - pad * 2) / paper.x, (canvas.height - pad * 2) / paper.y);
  view = {
    scale: scale,
    offsetX: (canvas.width - paper.x * scale) / 2,
    offsetY: (canvas.height - paper.y * scale) / 2,
  };
}

function mmToPx(p) {
  return {
    x: view.offsetX + p.x * view.scale,
    y: view.offsetY + p.y * view.scale,
  };
}

function pxToMm(x, y) {
  const mx = (x - view.offsetX) / view.scale;
  const my = (y - view.offsetY) / view.scale;
  return {
    x: clamp(mx, 0, paper.x),
    y: clamp(my, 0, paper.y),
  };
}

function pointFromPointer(e) {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (canvas.width / r.width);
  const y = (e.clientY - r.top) * (canvas.height / r.height);
  return pxToMm(x, y);
}

function smoothPath(points) {
  if (points.length < 3) return points.slice();
  const factor = Number(smoothingInput.value);
  if (factor <= 0.001) return points.slice();
  const passes = factor < 0.34 ? 1 : factor < 0.67 ? 2 : 3;
  const alpha = 0.12 + factor * 0.2;
  let out = points.slice();
  for (let pass = 0; pass < passes; pass += 1) {
    const next = [out[0]];
    for (let i = 1; i < out.length - 1; i += 1) {
      const prev = out[i - 1];
      const cur = out[i];
      const after = out[i + 1];
      next.push({
        x: cur.x * (1 - alpha * 2) + (prev.x + after.x) * alpha,
        y: cur.y * (1 - alpha * 2) + (prev.y + after.y) * alpha,
      });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

function getExportStrokes() {
  return strokes.map((s) => smoothPath(s.points)).filter((s) => s.length > 0);
}

function stampRound(pointMm, sizeMm) {
  const p = mmToPx(pointMm);
  const radius = Math.max(0.5, (sizeMm * view.scale) / 2);
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function stampFlat(pointMm, widthMm, angleDeg) {
  const p = mmToPx(pointMm);
  const rx = Math.max(0.6, (widthMm * view.scale) / 2);
  const ry = Math.max(0.6, widthMm * view.scale * 0.1);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.beginPath();
  ctx.fillRect(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function stampStroke(points) {
  if (!points.length) return;
  const size = brushSizeMm();
  const stepMm = Math.max(0.35, size * 0.25);
  const flat = brushType.value === "flat";
  const angle = Number(flatAngle.value);
  const width = Number(flatWidth.value);
  const round = Number(roundSize.value);
  const stamp = (pt) => {
    if (flat) {
      stampFlat(pt, width, angle);
    } else {
      stampRound(pt, round);
    }
  };
  stamp(points[0]);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = dist(a, b);
    const steps = Math.max(1, Math.ceil(length / stepMm));
    for (let j = 1; j <= steps; j += 1) {
      stamp(lerp(a, b, j / steps));
    }
  }
}

function drawGridAndGuides() {
  if (showGrid.checked) {
    const drawGridLine = (x1, y1, x2, y2, style, widthPx) => {
      ctx.beginPath();
      const a = mmToPx({ x: x1, y: y1 });
      const b = mmToPx({ x: x2, y: y2 });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = style;
      ctx.lineWidth = widthPx;
      ctx.stroke();
    };
    for (let x = 0; x <= paper.x; x += 5) {
      const major = x % 25 === 0;
      drawGridLine(x, 0, x, paper.y, major ? "#cbd3e2" : "#e7ebf3", major ? 1.1 : 0.7);
    }
    for (let y = 0; y <= paper.y; y += 5) {
      const major = y % 25 === 0;
      drawGridLine(0, y, paper.x, y, major ? "#cbd3e2" : "#e7ebf3", major ? 1.1 : 0.7);
    }
  }

  const outerTopLeft = mmToPx({ x: 0, y: 0 });
  const outerBottomRight = mmToPx({ x: paper.x, y: paper.y });
  ctx.strokeStyle = "#c6cfdf";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(outerTopLeft.x) + 0.5,
    Math.round(outerTopLeft.y) + 0.5,
    Math.round(outerBottomRight.x - outerTopLeft.x),
    Math.round(outerBottomRight.y - outerTopLeft.y),
  );

  const margin = clamp(paper.marginMm, 0, Math.min(paper.x, paper.y) / 2);
  const innerTopLeft = mmToPx({ x: margin, y: margin });
  const innerBottomRight = mmToPx({ x: paper.x - margin, y: paper.y - margin });
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "#7e889f";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(innerTopLeft.x) + 0.5,
    Math.round(innerTopLeft.y) + 0.5,
    Math.round(innerBottomRight.x - innerTopLeft.x),
    Math.round(innerBottomRight.y - innerTopLeft.y),
  );
  ctx.restore();
}

function redraw() {
  frameTimer = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawGridAndGuides();
  ctx.fillStyle = "rgba(17, 17, 17, 0.92)";
  for (const stroke of strokes) {
    stampStroke(smoothPath(stroke.points));
  }
}

function queueRedraw() {
  if (frameTimer != null) return;
  frameTimer = requestAnimationFrame(redraw);
}

function toSvg() {
  const svgWidth = paper.x * svgUnitsPerMm;
  const svgHeight = paper.y * svgUnitsPerMm;
  const paths = getExportStrokes()
    .filter((s) => s.length > 0)
    .map((stroke) => {
      const d = stroke
        .map((pt, i) => {
          const x = pt.x * svgUnitsPerMm;
          const y = pt.y * svgUnitsPerMm;
          return (i === 0 ? "M " : "L ") + fmt(x) + " " + fmt(y);
        })
        .join(" ");
      return '<path d="' + d + '" fill="none" stroke="black" stroke-width="1" />';
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + fmt(svgWidth) + " " + fmt(svgHeight) + '">',
    paths,
    "</svg>",
  ].join("\n");
}

function streamNow() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    status.textContent = "Socket not connected";
    return;
  }
  socket.send(JSON.stringify({ c: "incoming-svg", p: { svg: toSvg() } }));
  status.textContent = "Streamed at " + new Date().toLocaleTimeString();
}

function queueAutoStream() {
  if (!autoStream.checked) return;
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    streamNow();
  }, 110);
}

function streamIfAutoEnabled() {
  if (autoStream.checked) {
    streamNow();
  }
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(protocol + "://" + location.host + "/chat");
  socket.addEventListener("open", () => {
    connected = true;
    updateBadges();
    status.textContent = "Connected";
  });
  socket.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (
        msg.c === "plan-options" &&
        msg.p &&
        msg.p.paperSize &&
        Number.isFinite(msg.p.paperSize.x) &&
        Number.isFinite(msg.p.paperSize.y) &&
        Number.isFinite(msg.p.marginMm)
      ) {
        paper = {
          x: Math.max(10, Number(msg.p.paperSize.x)),
          y: Math.max(10, Number(msg.p.paperSize.y)),
          marginMm: Math.max(0, Number(msg.p.marginMm)),
        };
        updateBadges();
        resizeCanvas();
        queueRedraw();
      }
    } catch (_e) {
      // ignore non-json
    }
  });
  socket.addEventListener("close", () => {
    connected = false;
    updateBadges();
    status.textContent = "Disconnected, retrying...";
    setTimeout(connect, 1000);
  });
  socket.addEventListener("error", () => {
    connected = false;
    updateBadges();
    status.textContent = "Socket error";
  });
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = pointFromPointer(e);
  current = { points: [p], filtered: p };
  strokes.push(current);
  queueRedraw();
});
canvas.addEventListener("pointermove", (e) => {
  if (!current) return;
  let p = pointFromPointer(e);
  const streamFactor = Number(streamlineInput.value);
  p = lerp(current.filtered, p, clamp(1 - streamFactor * 0.85, 0.05, 1));
  current.filtered = p;
  if (snapGrid.checked) {
    p = { x: Math.round(p.x / 5) * 5, y: Math.round(p.y / 5) * 5 };
  }
  const last = current.points[current.points.length - 1];
  if (!last || dist(last, p) >= Number(minDistanceInput.value)) {
    current.points.push(p);
    queueRedraw();
  }
  queueAutoStream();
});
canvas.addEventListener("pointerup", () => {
  current = null;
  queueRedraw();
  streamIfAutoEnabled();
});
canvas.addEventListener("pointerleave", () => {
  current = null;
});

undoBtn.addEventListener("click", () => {
  if (strokes.length > 0) {
    strokes.pop();
    queueRedraw();
    streamIfAutoEnabled();
  }
});
clearBtn.addEventListener("click", () => {
  strokes.length = 0;
  queueRedraw();
  streamIfAutoEnabled();
});
streamBtn.addEventListener("click", streamNow);

brushType.addEventListener("change", () => {
  updateControlLabels();
  queueRedraw();
});
[roundSize, flatWidth, flatAngle, showGrid, snapGrid, streamlineInput, smoothingInput, minDistanceInput].forEach(
  (el) => {
    el.addEventListener("input", () => {
      updateControlLabels();
      queueRedraw();
    });
  },
);
window.addEventListener("resize", () => {
  resizeCanvas();
  queueRedraw();
});

updateControlLabels();
resizeCanvas();
queueRedraw();
connect();
