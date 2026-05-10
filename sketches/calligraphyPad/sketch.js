const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const controlPanel = document.getElementById("controlPanel");
const collapseBtn = document.getElementById("collapseBtn");
const showPanelBtn = document.getElementById("showPanelBtn");
const undoBtn = document.getElementById("undoBtn");
const clearBtn = document.getElementById("clearBtn");
const streamBtn = document.getElementById("streamBtn");
const floatingUndoBtn = document.getElementById("floatingUndoBtn");
const floatingStreamBtn = document.getElementById("floatingStreamBtn");
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
const drawToolBtn = document.getElementById("drawToolBtn");
const lassoToolBtn = document.getElementById("lassoToolBtn");
const transformToolBtn = document.getElementById("transformToolBtn");

const strokes = [];
let current = null;
let socket = null;
let streamTimer = null;
let frameTimer = null;
let connected = false;
let paper = { x: 210, y: 297, marginMm: 20 };
let view = { scale: 1, offsetX: 0, offsetY: 0 };
let tool = "draw";
let panelCollapsed = false;
let lassoPoints = [];
let transformState = null;
const selectedStrokeIds = new Set();
const svgUnitsPerMm = 96 / 25.4;
const saxiHost = "127.0.0.1:9080";
let nextStrokeId = 1;

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

function makeStrokeId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const id = nextStrokeId;
  nextStrokeId += 1;
  return `stroke-${id}`;
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

function updateToolButtons() {
  drawToolBtn.classList.toggle("active", tool === "draw");
  lassoToolBtn.classList.toggle("active", tool === "lasso");
  transformToolBtn.classList.toggle("active", tool === "transform");
}

function setTool(next) {
  tool = next;
  current = null;
  lassoPoints = [];
  transformState = null;
  if (tool !== "transform") {
    selectedStrokeIds.clear();
  }
  updateToolButtons();
  queueRedraw();
}

function setPanelCollapsed(next) {
  panelCollapsed = next;
  controlPanel.classList.toggle("collapsed", panelCollapsed);
  showPanelBtn.classList.toggle("hidden", !panelCollapsed);
  resizeCanvas();
  queueRedraw();
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(320, canvas.parentElement.clientWidth);
  const cssH = Math.max(360, canvas.parentElement.clientHeight);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const pad = 18 * dpr;
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
  ctx.fillRect(-rx, -ry / 2, rx * 2, ry);
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

function drawPolyline(points, color, width) {
  if (points.length < 2) return;
  ctx.beginPath();
  const first = mmToPx(points[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const p = mmToPx(points[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function computeSelectionBounds() {
  const selected = strokes.filter((stroke) => selectedStrokeIds.has(stroke.id));
  if (!selected.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of selected) {
    for (const pt of stroke.points) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function getTransformHandles(bounds) {
  const topLeft = mmToPx({ x: bounds.minX, y: bounds.minY });
  const topRight = mmToPx({ x: bounds.maxX, y: bounds.minY });
  const bottomLeft = mmToPx({ x: bounds.minX, y: bounds.maxY });
  const bottomRight = mmToPx({ x: bounds.maxX, y: bounds.maxY });
  const topCenter = mmToPx({ x: bounds.centerX, y: bounds.minY });
  return {
    tl: topLeft,
    tr: topRight,
    bl: bottomLeft,
    br: bottomRight,
    rotate: { x: topCenter.x, y: topCenter.y - 32 },
  };
}

function hitTestTransform(pointMm) {
  const bounds = computeSelectionBounds();
  if (!bounds) return null;
  const pointPx = mmToPx(pointMm);
  const handles = getTransformHandles(bounds);
  const handleRadius = 12;
  for (const [name, pt] of Object.entries(handles)) {
    if (Math.hypot(pointPx.x - pt.x, pointPx.y - pt.y) <= handleRadius) {
      return { type: name === "rotate" ? "rotate" : "scale", handle: name, bounds };
    }
  }
  if (
    pointMm.x >= bounds.minX &&
    pointMm.x <= bounds.maxX &&
    pointMm.y >= bounds.minY &&
    pointMm.y <= bounds.maxY
  ) {
    return { type: "move", bounds };
  }
  return null;
}

function applyTransformFromState(pointMm) {
  if (!transformState) return;
  const bounds = transformState.bounds;
  const cx = bounds.centerX;
  const cy = bounds.centerY;
  let moveX = 0;
  let moveY = 0;
  let scaleX = 1;
  let scaleY = 1;
  let angle = 0;

  if (transformState.type === "move") {
    moveX = pointMm.x - transformState.anchor.x;
    moveY = pointMm.y - transformState.anchor.y;
  } else if (transformState.type === "rotate") {
    const startAngle = Math.atan2(transformState.anchor.y - cy, transformState.anchor.x - cx);
    const nextAngle = Math.atan2(pointMm.y - cy, pointMm.x - cx);
    angle = nextAngle - startAngle;
  } else if (transformState.type === "scale") {
    const sx0 = transformState.anchor.x - cx;
    const sy0 = transformState.anchor.y - cy;
    const sx1 = pointMm.x - cx;
    const sy1 = pointMm.y - cy;
    scaleX = Math.abs(sx0) < 0.001 ? 1 : sx1 / sx0;
    scaleY = Math.abs(sy0) < 0.001 ? 1 : sy1 / sy0;
    scaleX = Math.sign(scaleX) * Math.max(0.05, Math.abs(scaleX));
    scaleY = Math.sign(scaleY) * Math.max(0.05, Math.abs(scaleY));
  }

  for (const stroke of strokes) {
    if (!selectedStrokeIds.has(stroke.id)) continue;
    const original = transformState.snapshot.get(stroke.id);
    stroke.points = original.map((pt) => {
      let x = pt.x - cx;
      let y = pt.y - cy;
      x *= scaleX;
      y *= scaleY;
      if (angle !== 0) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        x = rx;
        y = ry;
      }
      return {
        x: clamp(cx + x + moveX, 0, paper.x),
        y: clamp(cy + y + moveY, 0, paper.y),
      };
    });
  }
}

function drawSelectionOverlay() {
  const bounds = computeSelectionBounds();
  if (bounds) {
    for (const stroke of strokes) {
      if (selectedStrokeIds.has(stroke.id)) {
        drawPolyline(smoothPath(stroke.points), "rgba(45, 139, 131, 0.9)", 2);
      }
    }
    const topLeft = mmToPx({ x: bounds.minX, y: bounds.minY });
    const bottomRight = mmToPx({ x: bounds.maxX, y: bounds.maxY });
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = "#2d8b83";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.restore();

    const handles = getTransformHandles(bounds);
    for (const [name, pt] of Object.entries(handles)) {
      if (name === "rotate") {
        ctx.beginPath();
        ctx.moveTo((topLeft.x + bottomRight.x) / 2, topLeft.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.strokeStyle = "#2d8b83";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = name === "rotate" ? "#2d8b83" : "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#2d8b83";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  if (lassoPoints.length > 1) {
    ctx.save();
    ctx.setLineDash([5, 5]);
    drawPolyline(lassoPoints, "#2d8b83", 1.5);
    ctx.restore();
  }
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
  drawSelectionOverlay();
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
  socket = new WebSocket(`${protocol}://${saxiHost}/chat`);
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

function beginStroke(point) {
  current = { id: makeStrokeId(), points: [point], filtered: point };
  strokes.push(current);
}

function finishLasso() {
  selectedStrokeIds.clear();
  if (lassoPoints.length >= 3) {
    for (const stroke of strokes) {
      if (stroke.points.some((pt) => pointInPolygon(pt, lassoPoints))) {
        selectedStrokeIds.add(stroke.id);
      }
    }
  }
  lassoPoints = [];
  if (selectedStrokeIds.size > 0) {
    tool = "transform";
    status.textContent = "Selection ready";
  } else {
    status.textContent = "Nothing selected";
  }
  updateToolButtons();
  queueRedraw();
}

function beginTransform(hit, pointMm) {
  transformState = {
    type: hit.type,
    handle: hit.handle || null,
    bounds: hit.bounds,
    anchor: pointMm,
    snapshot: new Map(
      strokes.filter((stroke) => selectedStrokeIds.has(stroke.id)).map((stroke) => [stroke.id, stroke.points.map((pt) => ({ ...pt }))]),
    ),
  };
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const point = pointFromPointer(e);
  if (tool === "draw") {
    beginStroke(point);
  } else if (tool === "lasso") {
    lassoPoints = [point];
    status.textContent = "Tracing selection";
  } else if (tool === "transform") {
    const hit = hitTestTransform(point);
    if (hit) {
      beginTransform(hit, point);
      status.textContent = hit.type === "move" ? "Moving selection" : hit.type === "rotate" ? "Rotating selection" : "Scaling selection";
    } else {
      selectedStrokeIds.clear();
      queueRedraw();
    }
  }
  queueRedraw();
});

canvas.addEventListener("pointermove", (e) => {
  const point = pointFromPointer(e);
  if (tool === "draw" && current) {
    let p = point;
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
  } else if (tool === "lasso" && lassoPoints.length > 0) {
    const last = lassoPoints[lassoPoints.length - 1];
    if (!last || dist(last, point) >= 1) {
      lassoPoints.push(point);
      queueRedraw();
    }
  } else if (tool === "transform" && transformState) {
    applyTransformFromState(point);
    queueRedraw();
  }
});

canvas.addEventListener("pointerup", () => {
  if (tool === "draw") {
    current = null;
    queueRedraw();
    streamIfAutoEnabled();
  } else if (tool === "lasso") {
    finishLasso();
  } else if (tool === "transform" && transformState) {
    transformState = null;
    queueRedraw();
    streamIfAutoEnabled();
  }
});

canvas.addEventListener("pointerleave", () => {
  if (tool === "draw") current = null;
});

function undoLast() {
  if (strokes.length > 0) {
    const removed = strokes.pop();
    selectedStrokeIds.delete(removed.id);
    queueRedraw();
    streamIfAutoEnabled();
  }
}

function clearAll() {
  strokes.length = 0;
  selectedStrokeIds.clear();
  lassoPoints = [];
  transformState = null;
  queueRedraw();
  streamIfAutoEnabled();
}

undoBtn.addEventListener("click", undoLast);
floatingUndoBtn.addEventListener("click", undoLast);
clearBtn.addEventListener("click", clearAll);
streamBtn.addEventListener("click", streamNow);
floatingStreamBtn.addEventListener("click", streamNow);
drawToolBtn.addEventListener("click", () => setTool("draw"));
lassoToolBtn.addEventListener("click", () => setTool("lasso"));
transformToolBtn.addEventListener("click", () => setTool("transform"));
collapseBtn.addEventListener("click", () => setPanelCollapsed(true));
showPanelBtn.addEventListener("click", () => setPanelCollapsed(false));

brushType.addEventListener("change", () => {
  updateControlLabels();
  queueRedraw();
});

[roundSize, flatWidth, flatAngle, showGrid, snapGrid, streamlineInput, smoothingInput, minDistanceInput].forEach((el) => {
  el.addEventListener("input", () => {
    updateControlLabels();
    queueRedraw();
  });
});

window.addEventListener("resize", () => {
  resizeCanvas();
  queueRedraw();
});

updateControlLabels();
updateToolButtons();
resizeCanvas();
queueRedraw();
connect();
