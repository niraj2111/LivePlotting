/**
 * Backend web server for controlling the EBB.
 * Serve both the front end UI as static files - made with React, and backend
 * API for controlling the EBB.
 * Keep open web sockets to the front end for real-time updates.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import cors from "cors";
import type { Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { EBB, type Hardware } from "./ebb.js";
import { type Motion, PenMotion, Plan } from "./planning.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import * as _self from "./server.js"; // use self-import for test mocking
import { formatDuration } from "./util.js";

type Com = string;

/**
 * Shorthand for getting the device info, either EBB or com port.
 * @param ebb
 * @param com
 * @returns
 */
const getDeviceInfo = (ebb: EBB | null, _com: Com) => {
  // biome-ignore lint/suspicious/noExplicitAny: private member access
  const portPath = (ebb?.port as any)?._path ?? null;
  return { path: portPath, hardware: ebb?.hardware };
};

/**
 * Start the express server.
 * @param port
 * @param hardware
 * @param com
 * @param enableCors
 * @param maxPayloadSize
 * @returns
 */
export async function startServer(
  port: number,
  hardware: Hardware = "v3",
  com: Com = null,
  enableCors = false,
  maxPayloadSize = "200mb",
  svgIoApiKey = "",
) {
  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/", express.static(path.join(__dirname, "..", "ui")));
  app.use(express.json({ limit: maxPayloadSize }));
  if (enableCors) {
    app.use(cors());
  }
  // Web and Socket server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  let ebb: EBB | null;
  let clients: WebSocket[] = [];
  let unpaused: Promise<void> | null = null;
  let signalUnpause: (() => void) | null = null;
  let motionIdx: number | null = null;
  let currentPlan: Plan | null = null;
  let latestPlanOptions: { paperSize: { x: number; y: number }; marginMm: number } | null = null;
  let plotting = false;
  let controller: AbortController | null = null;

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("message", (message) => {
      const msg = JSON.parse(message.toString());
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({ c: "pong" }));
          break;
        case "limp":
          if (ebb) {
            ebb.disableMotors();
          }
          break;
        case "setPenHeight":
          if (ebb) {
            (async () => {
              if (await ebb.supportsSR()) {
                await ebb.setServoPowerTimeout(10000, true);
              }
              await ebb.setPenHeight(msg.p.height, msg.p.rate);
            })();
          }
          break;
        case "changeHardware":
          ebb?.changeHardware(msg.p.hardware);
          broadcast({ c: "dev", p: getDeviceInfo(ebb, com) });
          break;
        case "incoming-svg":
          if (typeof msg.p?.svg === "string") {
            broadcast({ c: "incoming-svg", p: { svg: msg.p.svg } });
          }
          break;
        case "plan-options":
          if (
            msg.p?.paperSize != null &&
            Number.isFinite(msg.p.paperSize.x) &&
            Number.isFinite(msg.p.paperSize.y) &&
            Number.isFinite(msg.p.marginMm)
          ) {
            latestPlanOptions = {
              paperSize: {
                x: Number(msg.p.paperSize.x),
                y: Number(msg.p.paperSize.y),
              },
              marginMm: Number(msg.p.marginMm),
            };
            broadcast({ c: "plan-options", p: latestPlanOptions });
          }
          break;
      }
    });

    // send starting params to clients
    ws.send(JSON.stringify({ c: "dev", p: getDeviceInfo(ebb, com) }));

    ws.send(JSON.stringify({ c: "svgio-enabled", p: svgIoApiKey !== "" }));

    ws.send(JSON.stringify({ c: "pause", p: { paused: !!unpaused } }));
    if (motionIdx != null) {
      ws.send(JSON.stringify({ c: "progress", p: { motionIdx } }));
    }
    if (currentPlan != null) {
      ws.send(JSON.stringify({ c: "plan", p: { plan: currentPlan } }));
    }
    if (latestPlanOptions != null) {
      ws.send(JSON.stringify({ c: "plan-options", p: latestPlanOptions }));
    }

    ws.on("close", () => {
      clients = clients.filter((w) => w !== ws);
    });
  });

  /**
   * /plot POST endpoint. Receive a plan on the POST body, and execute it.
   */
  app.post("/plot", async (req: Request, res: Response) => {
    if (plotting) {
      console.log("Received plot request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    plotting = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const plan = Plan.deserialize(req.body);
      currentPlan = req.body;
      console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
      console.log(ebb != null ? "Beginning plot..." : "Simulating plot...");
      res.status(200).end();

      const begin = Date.now();
      let wakeLock: { release(): void } | null = null;

      // The wake-lock module is macOS-only.
      if (process.platform === "darwin") {
        try {
          // Dynamically import wake-lock only on macOS
          const { WakeLock } = await import("wake-lock");
          wakeLock = new WakeLock("saxi plotting");
        } catch (_error) {
          console.warn("Couldn't acquire wake lock. Ensure your machine does not sleep during plotting");
        }
      } else {
        console.log("Wake lock not available on this platform. Ensure your machine does not sleep during plotting");
      }
      try {
        await doPlot(ebb != null ? realPlotter : simPlotter, plan, signal);
        const end = Date.now();
        console.log(`Plot took ${formatDuration((end - begin) / 1000)}`);
      } finally {
        if (wakeLock) {
          wakeLock.release();
        }
      }
    } finally {
      plotting = false;
      controller = null;
    }
  });

  app.get("/plot/status", (_req, res) => {
    res.json({ plotting });
  });

  app.post("/cancel", (_req: Request, res: Response) => {
    if (controller) {
      controller.abort();
      controller = null;
    }
    ebb?.cancel();
    if (unpaused) {
      signalUnpause();
      broadcast({ c: "pause", p: { paused: false } });
    }
    unpaused = signalUnpause = null;
    res.status(200).end();
  });

  app.post("/pause", (_req: Request, res: Response) => {
    if (!unpaused) {
      unpaused = new Promise((resolve) => {
        signalUnpause = resolve;
      });
      broadcast({ c: "pause", p: { paused: true } });
    }
    res.status(200).end();
  });

  app.post("/resume", (_req: Request, res: Response) => {
    if (signalUnpause) {
      signalUnpause();
      signalUnpause = unpaused = null;
    }
    res.status(200).end();
  });

  app.get("/stream-input", (_req: Request, res: Response) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>saxi stream input</title>
    <style>
      :root {
        --bg: #f7f8fb;
        --fg: #272a3a;
        --muted: #687087;
        --line: #d7dcea;
        --accent: #3f9991;
        --danger: #c15353;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Work Sans", sans-serif;
        color: var(--fg);
        background: var(--bg);
      }
      main { max-width: 1200px; margin: 0 auto; padding: 14px; }
      h1 { margin: 0 0 6px; font-size: 22px; }
      p { margin: 0 0 12px; color: var(--muted); }
      .grid { display: grid; grid-template-columns: 320px 1fr; gap: 12px; align-items: start; }
      .panel {
        background: #fff;
        border: 1px solid var(--line);
        padding: 10px;
      }
      .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
      .row.tight { margin-bottom: 6px; }
      .row label { font-size: 12px; color: var(--muted); min-width: 90px; }
      button {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--fg);
        font: inherit;
        padding: 7px 11px;
        cursor: pointer;
      }
      button.primary { border-color: var(--accent); color: var(--accent); font-weight: 700; }
      button.warn { border-color: var(--danger); color: var(--danger); }
      input[type="range"] { width: 160px; }
      input[type="number"], select {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--fg);
        font: inherit;
        padding: 5px 6px;
      }
      .badges {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      .badge {
        border: 1px solid var(--line);
        background: #fff;
        font-size: 11px;
        color: var(--muted);
        padding: 2px 7px;
      }
      canvas {
        width: 100%;
        height: auto;
        border: 1px solid var(--line);
        background: white;
        touch-action: none;
        display: block;
      }
      .status { font-size: 12px; color: var(--muted); }
      code { background: #eef2f8; padding: 1px 4px; }
      .canvas-wrap {
        background: #fff;
        border: 1px solid var(--line);
        padding: 10px;
      }
      .small { font-size: 11px; color: var(--muted); }
      @media (max-width: 980px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Stream Drawing Input</h1>
      <p>Open saxi in one tab (<code>/</code>) and this page in another (<code>/stream-input</code>). This canvas follows saxi paper size and streams centerline SVG.</p>
      <div class="badges">
        <span class="badge" id="connectionBadge">socket: connecting</span>
        <span class="badge" id="paperBadge">paper: 210 x 297 mm</span>
        <span class="badge" id="brushBadge">brush: round 1.6mm</span>
      </div>
      <div class="grid">
        <section class="panel">
          <div class="row">
            <button id="undoBtn" type="button">Undo</button>
            <button id="clearBtn" class="warn" type="button">Clear</button>
            <button id="streamBtn" class="primary" type="button">Stream</button>
          </div>

          <div class="row tight">
            <label><input id="autoStream" type="checkbox" /> Auto stream</label>
            <label><input id="showGrid" type="checkbox" checked /> Show grid</label>
            <label><input id="snapGrid" type="checkbox" /> Snap to grid</label>
          </div>

          <hr />

          <div class="row">
            <label for="brushType">Brush</label>
            <select id="brushType">
              <option value="round">Round</option>
              <option value="flat">Flat nib</option>
            </select>
          </div>
          <div class="row" id="roundRow">
            <label for="roundSize">Round size</label>
            <input id="roundSize" type="range" min="0.4" max="8" step="0.1" value="1.6" />
            <span id="roundSizeValue" class="small">1.6 mm</span>
          </div>
          <div id="flatControls" style="display:none;">
            <div class="row">
              <label for="flatWidth">Flat width</label>
              <input id="flatWidth" type="range" min="0.6" max="12" step="0.1" value="3.2" />
              <span id="flatWidthValue" class="small">3.2 mm</span>
            </div>
            <div class="row">
              <label for="flatAngle">Nib angle</label>
              <input id="flatAngle" type="range" min="0" max="180" step="1" value="40" />
              <span id="flatAngleValue" class="small">40 deg</span>
            </div>
          </div>

          <hr />

          <div class="row">
            <label for="streamline">Streamline</label>
            <input id="streamline" type="range" min="0" max="1" step="0.01" value="0.45" />
            <span id="streamlineValue" class="small">0.45</span>
          </div>
          <div class="row">
            <label for="smoothing">Smoothing</label>
            <input id="smoothing" type="range" min="0" max="1" step="0.01" value="0.25" />
            <span id="smoothingValue" class="small">0.25</span>
          </div>
          <div class="row">
            <label for="minDistance">Min distance</label>
            <input id="minDistance" type="range" min="0.1" max="5" step="0.1" value="0.6" />
            <span id="minDistanceValue" class="small">0.6 mm</span>
          </div>

          <p id="status" class="status">Connecting...</p>
          <p class="small">Grid: minor 5mm, major 25mm. Margin guide follows saxi margin.</p>
        </section>

        <section class="canvas-wrap">
          <canvas id="canvas"></canvas>
        </section>
      </div>
    </main>
    <script>
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
        return Number(n).toFixed(3).replace(/\\.0+$/, "").replace(/(\\.\\d*[1-9])0+$/, "$1");
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
        paperBadge.textContent = "paper: " + fmt(paper.x) + " x " + fmt(paper.y) + " mm, margin " + fmt(paper.marginMm) + " mm";
        if (brushType.value === "round") {
          brushBadge.textContent = "brush: round " + fmt(Number(roundSize.value)) + " mm";
        } else {
          brushBadge.textContent = "brush: flat " + fmt(Number(flatWidth.value)) + " mm @ " + fmt(Number(flatAngle.value)) + " deg";
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
        const alpha = 0.12 + factor * 0.20;
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
        return strokes
          .map((s) => smoothPath(s.points))
          .filter((s) => s.length > 0);
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
        const ry = Math.max(0.6, widthMm * view.scale * 0.20);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((angleDeg * Math.PI) / 180);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
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
          .join("\\n");
        return [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + fmt(svgWidth) + " " + fmt(svgHeight) + '">',
          paths,
          "</svg>",
        ].join("\\n");
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
      [roundSize, flatWidth, flatAngle, showGrid, snapGrid, streamlineInput, smoothingInput, minDistanceInput].forEach((el) =>
        el.addEventListener("input", () => {
          updateControlLabels();
          queueRedraw();
        }),
      );
      window.addEventListener("resize", () => {
        resizeCanvas();
        queueRedraw();
      });

      updateControlLabels();
      resizeCanvas();
      queueRedraw();
      connect();
    </script>
  </body>
</html>`);
  });

  app.post("/generate", async (req: Request, res: Response) => {
    if (plotting) {
      console.log("Received generate request, but a plot is already in progress!");
      res.status(400).end("Plot in progress");
      return;
    }
    const { prompt, vecType } = req.body;
    try {
      // call the api and return the svg
      const apiResp = await fetch("https://api.svg.io/v1/generate-image", {
        method: "post",
        headers: {
          Authorization: `Bearer ${svgIoApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, style: vecType, negativePrompt: "" }),
      });
      // forward the api response
      const data = await apiResp.json();
      res.status(apiResp.status).send(data);
    } catch (err) {
      console.error(err);
      res.status(500).end();
    }
  });

  function broadcast(msg: Record<string, unknown>) {
    for (const client of clients) {
      try {
        client.send(JSON.stringify(msg));
      } catch (e) {
        console.warn(e);
      }
    }
  }

  interface Plotter {
    prePlot: (initialPenHeight: number) => Promise<void>;
    executeMotion: (m: Motion, progress: [number, number]) => Promise<void>;
    postCancel: (initialPenHeight: number) => Promise<void>;
    postPlot: () => Promise<void>;
  }

  const realPlotter: Plotter = {
    async prePlot(initialPenHeight: number): Promise<void> {
      await ebb.enableMotors(1); // 16x microstepping, matches defaults from Axidraw
      await ebb.setPenHeight(initialPenHeight, 1000, 1000);
    },
    async executeMotion(motion: Motion, _progress: [number, number]): Promise<void> {
      await ebb.executeMotion(motion);
    },
    async postCancel(initialPenHeight: number): Promise<void> {
      await ebb.setPenHeight(initialPenHeight, 1000);
      await ebb.command("HM,4000"); // HM returns carriage home without 3rd and 4th arguments
    },
    async postPlot(): Promise<void> {
      await ebb.waitUntilMotorsIdle();
      await ebb.disableMotors();
    },
  };

  const simPlotter: Plotter = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async prePlot(_initialPenHeight: number): Promise<void> {},
    async executeMotion(motion: Motion, progress: [number, number]): Promise<void> {
      console.log(`Motion ${progress[0] + 1}/${progress[1]}`);
      await new Promise((resolve) => setTimeout(resolve, motion.duration() * 1000));
    },
    async postCancel(_initialPenHeight: number): Promise<void> {
      console.log("Plot cancelled");
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async postPlot(): Promise<void> {},
  };

  async function doPlot(plotter: Plotter, plan: Plan, signal: AbortSignal): Promise<void> {
    const abortPromise = onceAbort(signal); // reuse abort promise
    unpaused = null;
    signalUnpause = null;
    motionIdx = 0;

    const firstPenMotion = plan.motions.find((x) => x instanceof PenMotion) as PenMotion;
    await plotter.prePlot(firstPenMotion.initialPos);

    let penIsUp = true;
    try {
      for (const motion of plan.motions) {
        broadcast({ c: "progress", p: { motionIdx } });

        await Promise.race([plotter.executeMotion(motion, [motionIdx, plan.motions.length]), abortPromise]);

        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }

        if (unpaused && penIsUp) {
          await Promise.race([unpaused, abortPromise]);
          broadcast({ c: "pause", p: { paused: false } });
        }

        motionIdx += 1;
      }

      broadcast({ c: "finished" });
    } catch (err) {
      if (signal.aborted) {
        await plotter.postCancel(firstPenMotion.initialPos);
        broadcast({ c: "cancelled" });
        return;
      }
      throw err; // propagate real errors
    } finally {
      motionIdx = null;
      currentPlan = null;
      await plotter.postPlot();
    }
  }

  function onceAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      async function connect() {
        const devices = ebbs(com, hardware);
        for await (const device of devices) {
          ebb = device;
          broadcast({ c: "dev", p: getDeviceInfo(ebb, com) });
        }
      }
      connect();
      const { family, address, port } = server.address() as AddressInfo;
      const addr = `${family === "IPv6" ? `[${address}]` : address}:${port}`;
      console.log(`Server listening on http://${addr}`);
      resolve(server);
    });
  });
}

async function tryOpen(com: Com) {
  const port = new SerialPortSerialPort(com);
  await port.open({ baudRate: 9600 });
  return port;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEBB(p: PortInfo): boolean {
  return (
    p.manufacturer === "SchmalzHaus" ||
    p.manufacturer === "SchmalzHaus LLC" ||
    (p.vendorId === "04D8" && p.productId === "FD92")
  );
}

async function listEBBs() {
  const Binding = autoDetect();
  const ports = await Binding.list();
  return ports.filter(isEBB).map((p: { path: string }) => p.path);
}

export async function waitForEbb(): Promise<Com> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ebbs = await listEBBs();
    if (ebbs.length) {
      return ebbs[0];
    }
    await sleep(5000);
  }
}

async function* ebbs(path?: string, hardware: Hardware = "v3") {
  while (true) {
    try {
      const com: Com = path || (await _self.waitForEbb()); // use self-import for test mocking
      console.log(`Found EBB at ${com}`);
      const port = await tryOpen(com);
      const closed = new Promise((resolve) => {
        port.addEventListener("disconnect", resolve, { once: true });
      });
      yield new EBB(port, hardware);
      await closed;
      yield null;
      console.error("Lost connection to EBB, reconnecting...");
    } catch (e) {
      console.error(`Error connecting to EBB: ${e.message}`);
      console.error("Retrying in 5 seconds...");
      await sleep(5000);
    }
  }
}

export async function connectEBB(hardware: Hardware, device: string | undefined): Promise<EBB | null> {
  let dev = device;
  if (!device) {
    const ebbs = await listEBBs();
    if (ebbs.length === 0) return null;
    dev = ebbs[0];
  }

  const port = await tryOpen(dev);
  return new EBB(port, hardware);
}
