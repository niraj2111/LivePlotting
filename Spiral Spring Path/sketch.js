const MM_PER_INCH = 25.4;
const TWO_PI_VALUE = Math.PI * 2;
const PAPER_PRESETS_MM = {
  Custom: null,
  "A3 Portrait": { w: 297, h: 420 },
  "A3 Landscape": { w: 420, h: 297 },
  "A4 Portrait": { w: 210, h: 297 },
  "A4 Landscape": { w: 297, h: 210 },
  "A5 Portrait": { w: 148, h: 210 },
  "A5 Landscape": { w: 210, h: 148 },
};

let pane;
let cnv;
let anchorFolder;
let gridFolder;
let gridTypeControlBlades = [];
let spineStyles = [];
let activeSpineIdx = 0;
let hoveredAnchorIndex = -1;
let draggedAnchorIndex = -1;
let hoveredAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
let draggedAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
let selectionMode = false;
let selectedAnchorIndices = new Set();
let marqueeSelection = null;
let geometryDirty = true;
let cachedRenderSpinePaths = [];
let cachedArcLengthSampleGroups = [];
let cachedSpringPaths = [];
let currentDisplayScale = 1;
let pinchGestureState = null;

const P = {
  canvasWMM: 148,
  canvasHMM: 210,
  paperPreset: "A5 Portrait",
  dpi: 96,
  previewScale: 1,
  fitToViewport: true,
  bg: "#ffffff",
  springColor: "#0b0d12",
  spineColor: "#3f7cff",
  anchorColor: "#ff6b6b",
  gridColor: "#d6dae3",
  gridType: "square",
  gridSpacingMM: 5,
  hexGridSizeMM: 5,
  cursiveSpacingMM: 5,
  cursiveSlantDeg: 70,
  cursiveMajorEvery: 4,
  snapToGrid: true,
  showGrid: true,
  showSpine: true,
  showAnchors: true,
  spineStrokeMM: 0.35,
  springStrokeMM: 0.8,
  anchorRadiusMM: 1.6,
  hoverRadiusMM: 2.6,
  hoverColor: "#ffd166",
  selectionColor: "#22c55e",
  coilAmplitudeMM: 6,
  coilPitchMM: 5,
  samplesPerTurn: 18,
  orbitMode: "blackLetter",
  spineSmoothing: 4,
  spineSampleStepMM: 2,
  offsetLineCount: 5,
  offsetGapMM: 3,
  blackLetterAngleDeg: -45,
  blackLetterNibWidthMM: 3,
  presetMode: "none",
  presetInsetMM: 20,
  presetCols: 8,
  presetRows: 10,
  presetSeed: 42,
  presetPointCount: 64,
  presetTurnBias: 1.35,
  presetStraightPenalty: 2.4,
  springArcRadiusMM: 8,
  showSpring: true,
  svgFilename: "Spiral-Spring-Path.svg",
};

const spinePoints = [];

function setup() {
  spineStyles = [createSpineStyle()];
  activeSpineIdx = 0;
  const size = getCanvasPixelSize();
  cnv = createCanvas(size.width, size.height);
  cnv.parent("wrap");
  cnv.style("display", "block");
  pixelDensity(1);
  noLoop();

  buildPane();
  hookUI();
  syncCanvasSize();
  redraw();
}

function draw() {
  background("#101114");
  updateHoveredAnchor();
  ensureGeometryCache();
  const paper = getPaperSizeMM();

  push();
  scale(getPxPerMM());

  drawPaper(paper.width, paper.height);
  withPaperClip(paper.width, paper.height, () => {
    if (P.showGrid) {
      drawGrid(paper.width, paper.height);
    }

    if (P.showSpine) {
      drawSpine();
    }

    if (spineStyles.some((style) => (style || createSpineStyle()).showSpring)) {
      drawSpring();
    }

    if (P.showAnchors) {
      drawAnchors();
    }
  });

  drawSelectionOverlay();

  pop();
}

function mousePressed() {
  if (!isPointerInsideCanvas()) {
    return;
  }

  updateHoveredAnchor();
  if (selectionMode) {
    handleSelectionMousePressed();
    return;
  }

  if (hoveredAnchorIndex >= 0) {
    if (hoveredAnchorMeta.spineIdx !== activeSpineIdx) {
      selectedAnchorIndices = new Set();
    }
    activeSpineIdx = hoveredAnchorMeta.spineIdx;
    draggedAnchorIndex = hoveredAnchorIndex;
    draggedAnchorMeta = { ...hoveredAnchorMeta };
    refreshAnchorMonitor();
    return;
  }

  const point = getSnappedMousePointMM();
  if (!point) {
    return;
  }

  const last = getLastSpinePoint();
  if (last && nearlyEqual(last.x, point.x) && nearlyEqual(last.y, point.y)) {
    return;
  }

  spinePoints.push(point);
  invalidateGeometry();
  refreshAnchorMonitor();
  redraw();
}

function mouseDragged() {
  if (selectionMode) {
    updateSelectionMarquee();
    return;
  }

  if (draggedAnchorIndex < 0) {
    return;
  }

  const point = getSnappedMousePointMM();
  if (!point) {
    return;
  }

  spinePoints[draggedAnchorIndex] = point;
  draggedAnchorMeta.flatIdx = draggedAnchorIndex;
  updateHoveredAnchor();
  invalidateGeometry();
  redraw();
}

function mouseReleased() {
  if (selectionMode) {
    finalizeSelectionMarquee();
    return;
  }

  if (draggedAnchorIndex >= 0) {
    refreshAnchorMonitor();
  }
  draggedAnchorIndex = -1;
  draggedAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
}

function mouseMoved() {
  const previous = hoveredAnchorIndex;
  updateHoveredAnchor();
  if (previous !== hoveredAnchorIndex) {
    redraw();
  }
}

function keyPressed() {
  if (key === "m" || key === "M") {
    selectionMode = !selectionMode;
    marqueeSelection = null;
    hoveredAnchorIndex = -1;
    draggedAnchorIndex = -1;
    hoveredAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
    draggedAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
    redraw();
    return;
  }

  if (key === "n" || key === "N") {
    startNewSpine();
    return;
  }

  if (selectionMode && selectedAnchorIndices.size > 0 && handleArrowKeyMove()) {
    return;
  }

  const isDeleteKey = keyCode === DELETE || keyCode === BACKSPACE;
  if (!isDeleteKey || hoveredAnchorIndex < 0) {
    return;
  }

  selectedAnchorIndices.delete(hoveredAnchorIndex);
  shiftSelectedIndicesAfterRemoval(hoveredAnchorIndex);
  spinePoints.splice(hoveredAnchorIndex, 1);
  hoveredAnchorIndex = -1;
  draggedAnchorIndex = -1;
  hoveredAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  draggedAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  syncSpineStylesWithSegments();
  invalidateGeometry();
  refreshAnchorMonitor();
  redraw();
}

function applyPreset() {
  const nextPoints = buildPresetPoints(P.presetMode);
  if (!nextPoints) {
    return;
  }

  replaceActiveSpinePoints(nextPoints);
  selectedAnchorIndices = new Set();
  marqueeSelection = null;
  hoveredAnchorIndex = -1;
  draggedAnchorIndex = -1;
  hoveredAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  draggedAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  syncSpineStylesWithSegments();
  selectedAnchorIndices = new Set();
  marqueeSelection = null;
  invalidateGeometry();
  refreshAnchorMonitor();
  redraw();
}

function windowResized() {
  updateCanvasDisplaySize();
}

function drawGrid(paperWMM, paperHMM) {
  const effectivePxPerMM = Math.max(0.0001, getPxPerMM() * Math.max(0.01, currentDisplayScale));
  const thinStrokeMM = Math.max(0.08, 1 / effectivePxPerMM);
  const majorStrokeMM = Math.max(0.12, 1.5 / effectivePxPerMM);
  stroke(P.gridColor);
  noFill();

  forEachGridLine(paperWMM, paperHMM, (lineDef) => {
    strokeWeight(lineDef.major ? majorStrokeMM : thinStrokeMM);
    line(lineDef.x1, lineDef.y1, lineDef.x2, lineDef.y2);
  });
}

function forEachGridLine(paperWMM, paperHMM, callback) {
  if (P.gridType === "hexagonal") {
    appendHexGridLines(paperWMM, paperHMM, callback);
    return;
  }
  if (P.gridType === "slantedCursive") {
    appendCursiveGridLines(paperWMM, paperHMM, callback);
    return;
  }
  appendSquareGridLines(paperWMM, paperHMM, callback);
}

function appendSquareGridLines(paperWMM, paperHMM, callback) {
  const spacing = Math.max(0.5, P.gridSpacingMM);
  let index = 0;
  for (let x = 0; x <= paperWMM + 0.001; x += spacing) {
    callback({ x1: x, y1: 0, x2: x, y2: paperHMM, major: index % 5 === 0 });
    index += 1;
  }

  index = 0;
  for (let y = 0; y <= paperHMM + 0.001; y += spacing) {
    callback({ x1: 0, y1: y, x2: paperWMM, y2: y, major: index % 5 === 0 });
    index += 1;
  }
}

function appendHexGridLines(paperWMM, paperHMM, callback) {
  const size = Math.max(0.5, P.hexGridSizeMM);
  const sqrt3 = Math.sqrt(3);
  const dx = sqrt3 * size;
  const dy = 1.5 * size;
  const maxRow = Math.ceil((paperHMM + size) / dy);
  const maxCol = Math.ceil((paperWMM + dx) / dx);

  for (let row = -1; row <= maxRow + 1; row += 1) {
    const cy = row * dy;
    const rowOffset = row % 2 === 0 ? 0 : dx / 2;
    for (let col = -1; col <= maxCol + 1; col += 1) {
      const cx = col * dx + rowOffset;
      const points = [];
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i + Math.PI / 6;
        points.push({
          x: cx + size * Math.cos(angle),
          y: cy + size * Math.sin(angle),
        });
      }
      for (let i = 0; i < 6; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % 6];
        callback({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, major: false });
      }
    }
  }
}

function appendCursiveGridLines(paperWMM, paperHMM, callback) {
  const spacing = Math.max(0.5, P.cursiveSpacingMM);
  const slantDeg = constrain(P.cursiveSlantDeg, 10, 140);
  const slantRad = (slantDeg * Math.PI) / 180;
  const sinA = Math.sin(slantRad);
  const cosA = Math.cos(slantRad);
  if (Math.abs(sinA) < 1e-6) {
    return;
  }
  const majorEvery = Math.max(1, Math.floor(P.cursiveMajorEvery));

  let rowIndex = 0;
  for (let y = 0; y <= paperHMM + 0.001; y += spacing) {
    callback({ x1: 0, y1: y, x2: paperWMM, y2: y, major: rowIndex % majorEvery === 0 });
    rowIndex += 1;
  }

  // Slanted family: -sin(a)*x + cos(a)*y = c, where c is quantized by spacing.
  const c0 = 0;
  const c1 = -sinA * paperWMM;
  const c2 = cosA * paperHMM;
  const c3 = -sinA * paperWMM + cosA * paperHMM;
  const minC = Math.min(c0, c1, c2, c3) - spacing;
  const maxC = Math.max(c0, c1, c2, c3) + spacing;
  const startK = Math.floor(minC / spacing);
  const endK = Math.ceil(maxC / spacing);

  for (let k = startK; k <= endK; k += 1) {
    const c = k * spacing;
    const xTop = (0 * cosA - c) / sinA;
    const xBottom = (paperHMM * cosA - c) / sinA;
    callback({ x1: xTop, y1: 0, x2: xBottom, y2: paperHMM, major: false });
  }
}

function drawPaper(widthMM, heightMM) {
  noStroke();
  fill(P.bg);
  rect(0, 0, widthMM, heightMM);
}

function withPaperClip(widthMM, heightMM, fn) {
  const ctx = drawingContext;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, widthMM, heightMM);
  ctx.clip();
  fn();
  ctx.restore();
}

function drawSpine() {
  const renderPaths = cachedRenderSpinePaths;
  const segments = getSpineSegments();
  if (renderPaths.length === 0 || segments.length === 0) {
    return;
  }

  noFill();

  for (let segmentIndex = 0; segmentIndex < renderPaths.length; segmentIndex += 1) {
    const renderPoints = renderPaths[segmentIndex];
    const style = spineStyles[segmentIndex] || createSpineStyle();
    stroke(style.spineColor);
    strokeWeight(P.spineStrokeMM);
    drawingContext.lineCap = "round";
    drawingContext.lineJoin = "round";
    if (renderPoints.length === 1) {
      point(renderPoints[0].x, renderPoints[0].y);
      continue;
    }

    beginShape();
    for (const point of renderPoints) {
      vertex(point.x, point.y);
    }
    endShape();
  }
}

function drawAnchors() {
  let spineIdx = 0;
  let anchorIdx = 0;
  for (let i = 0; i < spinePoints.length; i += 1) {
    const point = spinePoints[i];
    if (!point) {
      spineIdx += 1;
      anchorIdx = 0;
      continue;
    }
    const style = spineStyles[spineIdx] || createSpineStyle();
    const isHovered = i === hoveredAnchorIndex;
    const isDragged = i === draggedAnchorIndex;
    const isSelected = spineIdx === activeSpineIdx && selectedAnchorIndices.has(i);

    if (isHovered || isDragged) {
      stroke(P.hoverColor);
      strokeWeight(0.35);
      fill(style.anchorColor);
      circle(point.x, point.y, P.hoverRadiusMM * 2);
    } else if (isSelected) {
      stroke(P.selectionColor);
      strokeWeight(0.35);
      fill(style.anchorColor);
      circle(point.x, point.y, P.hoverRadiusMM * 2);
    } else {
      noStroke();
      fill(style.anchorColor);
    }
    circle(point.x, point.y, P.anchorRadiusMM * 2);
    anchorIdx += 1;
  }
}

function drawSelectionOverlay() {
  if (!marqueeSelection) {
    return;
  }

  const x = Math.min(marqueeSelection.start.x, marqueeSelection.end.x);
  const y = Math.min(marqueeSelection.start.y, marqueeSelection.end.y);
  const w = Math.abs(marqueeSelection.end.x - marqueeSelection.start.x);
  const h = Math.abs(marqueeSelection.end.y - marqueeSelection.start.y);

  noFill();
  stroke(P.selectionColor);
  strokeWeight(0.35);
  rect(x, y, w, h);
}

function drawSpring() {
  const springPaths = cachedSpringPaths;
  if (springPaths.length === 0) {
    return;
  }

  noFill();
  drawingContext.globalCompositeOperation = "multiply";
  for (let segmentIndex = 0; segmentIndex < springPaths.length; segmentIndex += 1) {
    const style = spineStyles[segmentIndex] || createSpineStyle();
    if (!style.showSpring) {
      continue;
    }
    const springGroup = springPaths[segmentIndex];
    stroke(style.springColor);
    strokeWeight(P.springStrokeMM);
    drawingContext.lineCap = "round";
    drawingContext.lineJoin = "round";
    for (const springPath of springGroup) {
      if (springPath.length < 2) {
        continue;
      }
      beginShape();
      for (const point of springPath) {
        vertex(point.x, point.y);
      }
      endShape();
    }
  }
  drawingContext.globalCompositeOperation = "source-over";
}

function generateSpringPaths() {
  const paths = [];

  for (let i = 0; i < cachedRenderSpinePaths.length; i += 1) {
    const renderPath = cachedRenderSpinePaths[i];
    const spineSamples = cachedArcLengthSampleGroups[i] || [];
    const springSettings = spineStyles[i] || createSpineStyle();
    if (renderPath.length < 2 || spineSamples.length < 2) {
      continue;
    }

    if (!springSettings.showSpring) {
      paths.push([]);
      continue;
    }

    if (springSettings.orbitMode === "blackLetter") {
      paths.push(generateBlackLetterPaths(renderPath, springSettings));
      continue;
    }

    const pitch = Math.max(0.5, springSettings.coilPitchMM);
    const amplitude = Math.max(0, springSettings.coilAmplitudeMM);
    if (springSettings.orbitMode === "offsetPaths") {
      paths.push(generateOffsetSpringPaths(renderPath, springSettings));
      continue;
    }

    const points = [];

    for (let sampleIndex = 0; sampleIndex < spineSamples.length; sampleIndex += 1) {
      const sample = spineSamples[sampleIndex];
      const phase = (sample.distance / pitch) * TWO_PI_VALUE;
      const offset = getOrbitOffset(
        phase,
        amplitude,
        sample.distance,
        pitch,
        springSettings.orbitMode
      );
      points.push({
        x: sample.x + sample.normalX * offset,
        y: sample.y + sample.normalY * offset,
      });
    }

    if (springSettings.orbitMode === "arcTurns") {
      paths.push([
        buildRoundedCornerPolyline(
          removeSequentialDuplicates(points),
          Math.max(0, springSettings.springArcRadiusMM),
          getRoundedCornerStep(springSettings.springArcRadiusMM, springSettings.spineSampleStepMM)
        )
      ]);
      continue;
    }

    paths.push([points]);
  }

  return paths;
}

function getRenderSpinePaths() {
  const spines = getSpineSegments();
  return spines
    .map((segment, index) => getRenderPathForSegment(segment, spineStyles[index] || createSpineStyle()))
    .filter((segment) => segment.length > 0);
}

function getRenderPathForSegment(segment, springSettings = P) {
  if (segment.length <= 2) {
    return segment.map(copyPoint);
  }

  const iterations = Math.max(0, Math.floor(springSettings.spineSmoothing));
  let points = segment.map(copyPoint);

  for (let i = 0; i < iterations; i += 1) {
    points = chaikin(points);
  }

  return points;
}

function chaikin(points) {
  if (points.length <= 2) {
    return points.map(copyPoint);
  }

  const next = [copyPoint(points[0])];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    next.push({
      x: lerp(a.x, b.x, 0.25),
      y: lerp(a.y, b.y, 0.25),
    });
    next.push({
      x: lerp(a.x, b.x, 0.75),
      y: lerp(a.y, b.y, 0.75),
    });
  }
  next.push(copyPoint(points[points.length - 1]));
  return next;
}

function getArcLengthSamplesForPath(renderPoints, springSettings = P) {
  if (renderPoints.length < 2) {
    return [];
  }

  const segments = [];
  let totalLength = 0;
  for (let i = 0; i < renderPoints.length - 1; i += 1) {
    const a = renderPoints[i];
    const b = renderPoints[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen > 0.0001) {
      segments.push({ a, b, segLen, startDist: totalLength });
      totalLength += segLen;
    }
  }

  if (segments.length === 0 || totalLength <= 0.0001) {
    return [];
  }

  const pitch = Math.max(0.5, springSettings.coilPitchMM);
  const samplesPerTurn = Math.max(8, Math.floor(springSettings.samplesPerTurn));
  const step = Math.min(
    Math.max(0.25, springSettings.spineSampleStepMM),
    pitch / 2,
    pitch / samplesPerTurn
  );
  const sampleCount = Math.max(2, Math.ceil(totalLength / step));
  const samples = [];
  let currentSegIdx = 0;

  for (let i = 0; i <= sampleCount; i += 1) {
    const distance = i === sampleCount ? totalLength : Math.min(i * step, totalLength);
    while (
      currentSegIdx < segments.length - 1 &&
      segments[currentSegIdx].startDist + segments[currentSegIdx].segLen < distance - 0.0001
    ) {
      currentSegIdx += 1;
    }
    const seg = segments[currentSegIdx];
    const t = seg.segLen > 0 ? (distance - seg.startDist) / seg.segLen : 0;
    samples.push({
      x: lerp(seg.a.x, seg.b.x, t),
      y: lerp(seg.a.y, seg.b.y, t),
      distance,
    });
  }

  for (let i = 0; i < samples.length; i += 1) {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const tangent = normalizeVector(next.x - prev.x, next.y - prev.y);
    samples[i].tangentX = tangent.x;
    samples[i].tangentY = tangent.y;
    samples[i].normalX = -tangent.y;
    samples[i].normalY = tangent.x;
  }

  return samples;
}

function ensureGeometryCache() {
  if (!geometryDirty) {
    return;
  }

  cachedRenderSpinePaths = getRenderSpinePaths();
  cachedArcLengthSampleGroups = cachedRenderSpinePaths.map((path, index) =>
    getArcLengthSamplesForPath(path, spineStyles[index] || createSpineStyle())
  );
  cachedSpringPaths = generateSpringPaths();
  geometryDirty = false;
}

function invalidateGeometry() {
  geometryDirty = true;
}

function getPolylineLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

function samplePolylineAtDistance(points, distance) {
  const target = Math.max(0, distance);
  let travelled = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const segmentLength = Math.hypot(b.x - a.x, b.y - a.y);
    if (segmentLength <= 0.0001) {
      continue;
    }

    if (travelled + segmentLength >= target || i === points.length - 2) {
      const localDistance = constrain(target - travelled, 0, segmentLength);
      const t = localDistance / segmentLength;
      return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
      };
    }

    travelled += segmentLength;
  }

  return copyPoint(points[points.length - 1]);
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (length <= 0.000001) {
    return { x: 1, y: 0 };
  }
  return {
    x: x / length,
    y: y / length,
  };
}

function buildPresetPoints(mode) {
  switch (mode) {
    case "spaceFill":
      return buildSpaceFillPreset();
    case "seedCurve":
      return buildSeedCurvePreset();
    case "seedFill":
      return buildSeedFillPreset();
    case "hamiltonian":
      return buildHamiltonianPreset();
    case "none":
    default:
      return null;
  }
}

function buildSpaceFillPreset() {
  const inset = getPresetInset();
  const cols = Math.max(2, Math.floor(P.presetCols));
  const rows = Math.max(2, Math.floor(P.presetRows));
  const usableW = Math.max(10, P.canvasWMM - inset * 2);
  const usableH = Math.max(10, P.canvasHMM - inset * 2);
  const dx = cols <= 1 ? 0 : usableW / (cols - 1);
  const dy = rows <= 1 ? 0 : usableH / (rows - 1);
  const points = [];

  for (let row = 0; row < rows; row += 1) {
    if (row % 2 === 0) {
      for (let col = 0; col < cols; col += 1) {
        points.push({
          x: inset + col * dx,
          y: inset + row * dy,
        });
      }
    } else {
      for (let col = cols - 1; col >= 0; col -= 1) {
        points.push({
          x: inset + col * dx,
          y: inset + row * dy,
        });
      }
    }
  }

  return snapPresetPoints(points);
}

function buildSeedCurvePreset() {
  const inset = getPresetInset();
  const cols = Math.max(2, Math.floor(P.presetCols));
  const rows = Math.max(2, Math.floor(P.presetRows));
  const usableW = Math.max(10, P.canvasWMM - inset * 2);
  const usableH = Math.max(10, P.canvasHMM - inset * 2);
  const dx = cols <= 1 ? 0 : usableW / (cols - 1);
  const dy = rows <= 1 ? 0 : usableH / (rows - 1);
  const rng = mulberry32(Math.floor(P.presetSeed));
  const maxPoints = Math.max(2, Math.floor(P.presetPointCount));
  const points = [];
  const visited = new Set();
  let col = Math.floor(rng() * cols);
  let row = Math.floor(rng() * rows);
  let lastDir = null;

  function keyOf(nextCol, nextRow) {
    return `${nextCol},${nextRow}`;
  }

  function getVisitedCentroid() {
    if (points.length === 0) {
      return { x: col, y: row };
    }
    let sumX = 0;
    let sumY = 0;
    for (const point of points) {
      sumX += (point.x - inset) / Math.max(dx, 0.0001);
      sumY += (point.y - inset) / Math.max(dy, 0.0001);
    }
    return {
      x: sumX / points.length,
      y: sumY / points.length,
    };
  }

  for (let i = 0; i < maxPoints; i += 1) {
    points.push({
      x: inset + col * dx,
      y: inset + row * dy,
    });
    visited.add(keyOf(col, row));

    const candidates = [];
    const centroid = getVisitedCentroid();
    for (let dRow = -1; dRow <= 1; dRow += 1) {
      for (let dCol = -1; dCol <= 1; dCol += 1) {
        if (dRow === 0 && dCol === 0) {
          continue;
        }

        const nextCol = col + dCol;
        const nextRow = row + dRow;
        if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) {
          continue;
        }

        const alreadyVisited = visited.has(keyOf(nextCol, nextRow));
        if (alreadyVisited) {
          continue;
        }

        const reversesLast =
          lastDir && lastDir.dCol === -dCol && lastDir.dRow === -dRow;
        const continuesLast =
          lastDir && lastDir.dCol === dCol && lastDir.dRow === dRow;
        const spreadBias = Math.hypot(nextCol - centroid.x, nextRow - centroid.y);
        const centerBias = Math.hypot(nextCol - (cols - 1) * 0.5, nextRow - (rows - 1) * 0.5);
        candidates.push({
          nextCol,
          nextRow,
          dCol,
          dRow,
          score:
            spreadBias * 1.4 +
            centerBias * 0.12 +
            (continuesLast ? 0.35 : 0) -
            (reversesLast ? 1.2 : 0) +
            rng() * 0.25,
        });
      }
    }

    if (candidates.length === 0) {
      break;
    }

    candidates.sort((a, b) => b.score - a.score);
    const pickIndex = candidates.length > 2 && rng() < 0.18 ? 1 : 0;
    const next = candidates[pickIndex];
    col = next.nextCol;
    row = next.nextRow;
    lastDir = { dCol: next.dCol, dRow: next.dRow };
  }

  return snapPresetPoints(removeSequentialDuplicates(points));
}

function buildSeedFillPreset() {
  const inset = getPresetInset();
  const cols = Math.max(2, Math.floor(P.presetCols));
  const rows = Math.max(2, Math.floor(P.presetRows));
  const usableW = Math.max(10, P.canvasWMM - inset * 2);
  const usableH = Math.max(10, P.canvasHMM - inset * 2);
  const dx = cols <= 1 ? 0 : usableW / (cols - 1);
  const dy = rows <= 1 ? 0 : usableH / (rows - 1);
  const targetCount = Math.min(cols * rows, Math.max(2, Math.floor(P.presetPointCount)));
  const cells = generateSeedFillCells(cols, rows, targetCount, Math.floor(P.presetSeed));

  if (!cells || cells.length === 0) {
    return snapPresetPoints(buildSpaceFillPreset().slice(0, targetCount));
  }

  const points = cells.map((cell) => ({
    x: inset + cell.col * dx,
    y: inset + cell.row * dy,
  }));

  return snapPresetPoints(points);
}

function buildHamiltonianPreset() {
  const inset = getPresetInset();
  const cols = Math.max(2, Math.floor(P.presetCols));
  const rows = Math.max(2, Math.floor(P.presetRows));
  const usableW = Math.max(10, P.canvasWMM - inset * 2);
  const usableH = Math.max(10, P.canvasHMM - inset * 2);
  const dx = cols <= 1 ? 0 : usableW / (cols - 1);
  const dy = rows <= 1 ? 0 : usableH / (rows - 1);
  const rng = mulberry32(Math.floor(P.presetSeed));

  const visited = new Array(rows).fill(null).map(() => new Array(cols).fill(false));
  const path = [];

  function getNeighbors(col, row) {
    const result = [];
    const directions = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    for (const [dCol, dRow] of directions) {
      const nextCol = col + dCol;
      const nextRow = row + dRow;
      if (
        nextCol >= 0 &&
        nextCol < cols &&
        nextRow >= 0 &&
        nextRow < rows &&
        !visited[nextRow][nextCol]
      ) {
        result.push({ col: nextCol, row: nextRow });
      }
    }

    return result;
  }

  function solve(col, row) {
    visited[row][col] = true;
    path.push({ x: inset + col * dx, y: inset + row * dy });
    if (path.length >= cols * rows) {
      return true;
    }

    const neighbors = getNeighbors(col, row)
      .map((neighbor) => {
        const previous = path[path.length - 2];
        const previousCol = previous ? Math.round((previous.x - inset) / Math.max(dx, 0.0001)) : null;
        const previousRow = previous ? Math.round((previous.y - inset) / Math.max(dy, 0.0001)) : null;
        const isStraight =
          previousCol !== null &&
          previousRow !== null &&
          neighbor.col - col === col - previousCol &&
          neighbor.row - row === row - previousRow;
        const turns = previousCol !== null && previousRow !== null && !isStraight;
        const straightPenalty = isStraight ? P.presetStraightPenalty : 0;
        const turnBonus = turns ? -P.presetTurnBias : 0;
        return {
          ...neighbor,
          score:
            getNeighbors(neighbor.col, neighbor.row).length * 2 +
            straightPenalty +
            turnBonus +
            rng() * 0.4,
        };
      })
      .sort((a, b) => a.score - b.score);

    for (const next of neighbors) {
      if (solve(next.col, next.row)) {
        return true;
      }
    }

    if (path.length >= Math.min(rows * cols, Math.max(2, Math.floor(P.presetPointCount)))) {
      return true;
    }

    if (path.length < 8) {
      path.pop();
      visited[row][col] = false;
      return false;
    }

    return true;
  }

  solve(0, 0);
  return snapPresetPoints(path);
}

function generateSeedFillCells(cols, rows, targetCount, seed) {
  const attempts = 24;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rng = mulberry32(seed + attempt * 1013);
    const result = buildFastSeedFillPath(cols, rows, targetCount, rng);
    if (result && result.length >= targetCount) {
      return result;
    }
  }

  return null;
}

function buildFastSeedFillPath(cols, rows, targetCount, rng) {
  const totalCells = cols * rows;
  const visited = new Uint8Array(totalCells);
  const path = [];
  const directions = [
    { dCol: 1, dRow: 0, dir: "E" },
    { dCol: -1, dRow: 0, dir: "W" },
    { dCol: 0, dRow: 1, dir: "S" },
    { dCol: 0, dRow: -1, dir: "N" },
  ];
  let col = Math.floor(rng() * cols);
  let row = Math.floor(rng() * rows);
  let previousDir = "";
  let straightRun = 0;
  const directionHistory = [];

  function indexOf(col, row) {
    return row * cols + col;
  }

  function isInBounds(col, row) {
    return col >= 0 && col < cols && row >= 0 && row < rows;
  }

  function countUnvisitedNeighbors(nextCol, nextRow) {
    let count = 0;
    for (const direction of directions) {
      const colCandidate = nextCol + direction.dCol;
      const rowCandidate = nextRow + direction.dRow;
      if (!isInBounds(colCandidate, rowCandidate)) {
        continue;
      }
      if (!visited[indexOf(colCandidate, rowCandidate)]) {
        count += 1;
      }
    }
    return count;
  }

  function countAxisBias(axis) {
    let count = 0;
    for (const dir of directionHistory) {
      if ((axis === "horizontal" && (dir === "E" || dir === "W")) ||
          (axis === "vertical" && (dir === "N" || dir === "S"))) {
        count += 1;
      }
    }
    return count;
  }

  function countBoundaryTouches(nextCol, nextRow) {
    let touches = 0;
    if (nextCol === 0 || nextCol === cols - 1) {
      touches += 1;
    }
    if (nextRow === 0 || nextRow === rows - 1) {
      touches += 1;
    }
    return touches;
  }

  function getAxis(dir) {
    return dir === "E" || dir === "W" ? "horizontal" : "vertical";
  }

  function getCandidates(currentCol, currentRow, currentDir, currentStraightRun) {
    const candidates = [];
    const centerCol = (cols - 1) * 0.5;
    const centerRow = (rows - 1) * 0.5;

    for (const direction of directions) {
      const nextCol = currentCol + direction.dCol;
      const nextRow = currentRow + direction.dRow;
      if (!isInBounds(nextCol, nextRow)) {
        continue;
      }
      const nextIndex = indexOf(nextCol, nextRow);
      if (visited[nextIndex]) {
        continue;
      }

      const onwardOptions = countUnvisitedNeighbors(nextCol, nextRow);
      const continuesStraight = currentDir === direction.dir;
      const turns = currentDir !== "" && currentDir !== direction.dir;
      const straightPenalty =
        continuesStraight
          ? P.presetStraightPenalty + currentStraightRun * (P.presetStraightPenalty * 0.5)
          : 0;
      const turnBonus = turns ? -P.presetTurnBias : 0;
      const deadEndPenalty = onwardOptions === 0 ? 3 : 0;
      const boundaryPenalty = countBoundaryTouches(nextCol, nextRow) * 0.65;
      const axisPenalty = countAxisBias(getAxis(direction.dir)) * 0.18;
      const centerBias =
        Math.abs(nextCol - centerCol) / Math.max(1, cols - 1) +
        Math.abs(nextRow - centerRow) / Math.max(1, rows - 1);

      candidates.push({
        col: nextCol,
        row: nextRow,
        dir: direction.dir,
        score:
          straightPenalty +
          turnBonus +
          deadEndPenalty +
          boundaryPenalty +
          axisPenalty -
          onwardOptions * 0.9 +
          centerBias * 0.18 +
          rng() * 0.28,
      });
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates;
  }

  visited[indexOf(col, row)] = 1;
  path.push({ col, row });

  while (path.length < targetCount) {
    const candidates = getCandidates(col, row, previousDir, straightRun);
    if (candidates.length === 0) {
      break;
    }

    const pickIndex = candidates.length > 1 && rng() < 0.18 ? 1 : 0;
    const next = candidates[pickIndex];
    col = next.col;
    row = next.row;
    visited[indexOf(col, row)] = 1;
    path.push({ col, row });
    straightRun = next.dir === previousDir ? straightRun + 1 : 0;
    previousDir = next.dir;
    directionHistory.push(next.dir);
    if (directionHistory.length > 8) {
      directionHistory.shift();
    }
  }

  return path;
}

function snapPresetPoints(points) {
  if (!P.snapToGrid) {
    return points.map(copyPoint);
  }

  return points.map((point) => ({
    x: constrain(snapPointToActiveGrid(point).x, 0, P.canvasWMM),
    y: constrain(snapPointToActiveGrid(point).y, 0, P.canvasHMM),
  }));
}

function getPresetInset() {
  return constrain(P.presetInsetMM, 0, Math.min(P.canvasWMM, P.canvasHMM) * 0.45);
}

function getRoundedCornerStep(radiusMM, sampleStepMM = P.spineSampleStepMM) {
  const radius = Math.max(0.25, radiusMM);
  return Math.max(0.2, Math.min(sampleStepMM, radius * 0.3, 2));
}

function generateOffsetSpringPaths(renderPath, springSettings = P) {
  const lineCount = Math.max(1, Math.floor(springSettings.offsetLineCount));
  const gap = Math.max(0, springSettings.offsetGapMM);
  const radius = Math.max(0, springSettings.springArcRadiusMM);
  const step = getRoundedCornerStep(radius, springSettings.spineSampleStepMM);
  const centerOffset = (lineCount - 1) * 0.5;
  const sourcePoints = simplifyOffsetSourcePath(renderPath, springSettings);
  const paths = [];

  if (sourcePoints.length < 2) {
    return paths;
  }

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const offsetAmount = (lineIndex - centerOffset) * gap;
    paths.push(buildOffsetPolyline(sourcePoints, offsetAmount, radius, step));
  }

  return paths;
}

function simplifyOffsetSourcePath(points, springSettings = P) {
  const uniquePoints = removeSequentialDuplicates(points).map(copyPoint);
  if (uniquePoints.length <= 2) {
    return uniquePoints;
  }

  const radius = Math.max(0, springSettings.springArcRadiusMM);
  const sampleStep = Math.max(0.1, springSettings.spineSampleStepMM);
  const radiusTolerance = radius > 0.0001 ? radius * 0.18 : sampleStep * 0.25;
  const epsilon = Math.max(0.08, Math.min(sampleStep * 0.4, radiusTolerance, 0.75));
  return removeNearlyCollinearPoints(simplifyPolylineRDP(uniquePoints, epsilon));
}

function buildOffsetPolyline(points, offsetAmount, radius, step) {
  const segments = getOffsetSegments(points, offsetAmount);
  if (segments.length === 0) {
    return [];
  }

  const rawPoints = [copyPoint(segments[0].start)];
  for (let i = 0; i < segments.length - 1; i += 1) {
    const current = segments[i];
    const next = segments[i + 1];
    const join = intersectLines(current.start, current.end, next.start, next.end);
    appendPointIfDistinct(
      rawPoints,
      clampOffsetJoinPoint(join, current.end, next.start, offsetAmount, radius)
    );
  }
  appendPointIfDistinct(rawPoints, segments[segments.length - 1].end);

  return buildRoundedCornerPolyline(removeNearlyCollinearPoints(rawPoints), radius, step);
}

function getOffsetSegments(points, offsetAmount) {
  const segments = [];

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const tangent = normalizeVector(b.x - a.x, b.y - a.y);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 0.0001) {
      continue;
    }

    const normal = {
      x: -tangent.y,
      y: tangent.x,
    };
    segments.push({
      start: {
        x: a.x + normal.x * offsetAmount,
        y: a.y + normal.y * offsetAmount,
      },
      end: {
        x: b.x + normal.x * offsetAmount,
        y: b.y + normal.y * offsetAmount,
      },
    });
  }

  return segments;
}

function intersectLines(a1, a2, b1, b2) {
  const denominator =
    (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
  if (Math.abs(denominator) <= 0.000001) {
    return null;
  }

  const detA = a1.x * a2.y - a1.y * a2.x;
  const detB = b1.x * b2.y - b1.y * b2.x;
  return {
    x: (detA * (b1.x - b2.x) - (a1.x - a2.x) * detB) / denominator,
    y: (detA * (b1.y - b2.y) - (a1.y - a2.y) * detB) / denominator,
  };
}

function clampOffsetJoinPoint(join, currentEnd, nextStart, offsetAmount, radius) {
  if (!join) {
    return copyPoint(currentEnd);
  }

  const miterLimit = Math.max(radius * 4, Math.abs(offsetAmount) * 6, 6);
  const distToCurrent = Math.hypot(join.x - currentEnd.x, join.y - currentEnd.y);
  const distToNext = Math.hypot(join.x - nextStart.x, join.y - nextStart.y);
  if (distToCurrent <= miterLimit && distToNext <= miterLimit) {
    return join;
  }

  return {
    x: (currentEnd.x + nextStart.x) * 0.5,
    y: (currentEnd.y + nextStart.y) * 0.5,
  };
}

function simplifyPolylineRDP(points, epsilon) {
  if (points.length <= 2) {
    return points.map(copyPoint);
  }

  let maxDistance = -1;
  let splitIndex = -1;

  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = getPointToLineDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      splitIndex = i;
    }
  }

  if (maxDistance <= epsilon || splitIndex < 0) {
    return [copyPoint(points[0]), copyPoint(points[points.length - 1])];
  }

  const left = simplifyPolylineRDP(points.slice(0, splitIndex + 1), epsilon);
  const right = simplifyPolylineRDP(points.slice(splitIndex), epsilon);
  return left.slice(0, -1).concat(right);
}

function getPointToLineDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.000001) {
    return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  }

  const area = Math.abs(
    dx * (lineStart.y - point.y) - (lineStart.x - point.x) * dy
  );
  return area / Math.sqrt(lengthSq);
}

function removeNearlyCollinearPoints(points, angleToleranceDeg = 2.5) {
  if (points.length <= 2) {
    return points.map(copyPoint);
  }

  const tolerance = radians(angleToleranceDeg);
  const result = [copyPoint(points[0])];

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = result[result.length - 1];
    const current = points[i];
    const next = points[i + 1];
    const inbound = normalizeVector(current.x - prev.x, current.y - prev.y);
    const outbound = normalizeVector(next.x - current.x, next.y - current.y);
    const dot = constrain(inbound.x * outbound.x + inbound.y * outbound.y, -1, 1);
    const angle = Math.acos(dot);

    if (angle >= tolerance) {
      result.push(copyPoint(current));
    }
  }

  result.push(copyPoint(points[points.length - 1]));
  return result;
}

function generateBlackLetterPaths(renderPoints, springSettings = P) {
  if (renderPoints.length < 2) {
    return [];
  }

  const spacing = Math.max(0.5, springSettings.coilPitchMM);
  const nibWidth = Math.max(0.1, springSettings.blackLetterNibWidthMM);
  const angle = radians(springSettings.blackLetterAngleDeg);
  const halfWidthX = Math.cos(angle) * nibWidth * 0.5;
  const halfWidthY = Math.sin(angle) * nibWidth * 0.5;
  const centers = getPolylineStampPoints(renderPoints, spacing);

  return centers.map((center) => [
    {
      x: center.x - halfWidthX,
      y: center.y - halfWidthY,
    },
    {
      x: center.x + halfWidthX,
      y: center.y + halfWidthY,
    },
  ]);
}

function getPolylineStampPoints(points, spacing) {
  const totalLength = getPolylineLength(points);
  if (totalLength <= 0.0001) {
    return [];
  }

  const step = Math.max(0.1, spacing);
  const stampCount = Math.max(1, Math.floor(totalLength / step));
  const samples = [];

  for (let i = 0; i <= stampCount; i += 1) {
    const distance = Math.min(i * step, totalLength);
    samples.push(samplePolylineAtDistance(points, distance));
  }

  const last = samples[samples.length - 1];
  const endPoint = points[points.length - 1];
  if (!last || !nearlyEqual(last.x, endPoint.x) || !nearlyEqual(last.y, endPoint.y)) {
    samples.push(copyPoint(endPoint));
  }

  return samples;
}

function buildRoundedCornerPolyline(points, radius, step) {
  if (points.length <= 2 || radius <= 0.0001) {
    return points.map(copyPoint);
  }

  const safeStep = Math.max(0.2, step);
  const result = [copyPoint(points[0])];

  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const corner = getRoundedCornerData(a, b, c, radius);

    if (!corner) {
      appendPointIfDistinct(result, b);
      continue;
    }

    appendPointIfDistinct(result, corner.start);
    const arcPoints = sampleArcPoints(corner, safeStep);
    for (const point of arcPoints) {
      appendPointIfDistinct(result, point);
    }
  }

  appendPointIfDistinct(result, points[points.length - 1]);
  return result;
}

function getRoundedCornerData(a, b, c, radius) {
  const inbound = normalizeVector(a.x - b.x, a.y - b.y);
  const outbound = normalizeVector(c.x - b.x, c.y - b.y);
  const lenIn = Math.hypot(b.x - a.x, b.y - a.y);
  const lenOut = Math.hypot(c.x - b.x, c.y - b.y);
  if (lenIn <= 0.0001 || lenOut <= 0.0001) {
    return null;
  }

  const dot = constrain(inbound.x * outbound.x + inbound.y * outbound.y, -1, 1);
  const angle = Math.acos(dot);
  if (angle <= 0.05 || Math.abs(Math.PI - angle) <= 0.05) {
    return null;
  }

  const tangentDistance = radius / Math.tan(angle / 2);
  const maxDistance = Math.min(lenIn, lenOut) * 0.5;
  const clampedDistance = Math.min(tangentDistance, maxDistance);
  if (clampedDistance <= 0.0001) {
    return null;
  }

  const effectiveRadius = clampedDistance * Math.tan(angle / 2);
  const bisectorRawX = inbound.x + outbound.x;
  const bisectorRawY = inbound.y + outbound.y;
  const bisectorLength = Math.hypot(bisectorRawX, bisectorRawY);
  if (bisectorLength <= 0.0001) {
    return null;
  }
  const bisector = {
    x: bisectorRawX / bisectorLength,
    y: bisectorRawY / bisectorLength,
  };

  const centerDistance = effectiveRadius / Math.sin(angle / 2);
  const start = {
    x: b.x + inbound.x * clampedDistance,
    y: b.y + inbound.y * clampedDistance,
  };
  const end = {
    x: b.x + outbound.x * clampedDistance,
    y: b.y + outbound.y * clampedDistance,
  };
  const center = {
    x: b.x + bisector.x * centerDistance,
    y: b.y + bisector.y * centerDistance,
  };

  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const turnCross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

  return {
    start,
    end,
    center,
    radius: effectiveRadius,
    startAngle,
    endAngle,
    clockwise: turnCross < 0,
  };
}

function sampleArcPoints(corner, step) {
  const { center, radius, startAngle, endAngle, clockwise, end } = corner;
  let sweep = endAngle - startAngle;

  if (clockwise && sweep >= 0) {
    sweep -= TWO_PI_VALUE;
  } else if (!clockwise && sweep <= 0) {
    sweep += TWO_PI_VALUE;
  }

  const arcLength = Math.abs(sweep) * radius;
  const segmentCount = Math.max(2, Math.ceil(arcLength / Math.max(0.2, step)));
  const points = [];

  for (let i = 1; i <= segmentCount; i += 1) {
    const t = i / segmentCount;
    const angle = startAngle + sweep * t;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }

  points[points.length - 1] = copyPoint(end);
  return points;
}

function appendPointIfDistinct(points, point) {
  const last = points[points.length - 1];
  if (!last || !nearlyEqual(last.x, point.x) || !nearlyEqual(last.y, point.y)) {
    points.push(copyPoint(point));
  }
}

function removeSequentialDuplicates(points) {
  const result = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (!last || !nearlyEqual(last.x, point.x) || !nearlyEqual(last.y, point.y)) {
      result.push(point);
    }
  }
  return result;
}

function handleSelectionMousePressed() {
  const point = getMousePointMM();
  if (!point) {
    return;
  }

  if (hoveredAnchorIndex >= 0) {
    if (hoveredAnchorMeta.spineIdx !== activeSpineIdx) {
      selectedAnchorIndices = new Set();
    }
    activeSpineIdx = hoveredAnchorMeta.spineIdx;
    if (keyIsDown(SHIFT)) {
      toggleAnchorSelection(hoveredAnchorIndex);
    } else {
      selectedAnchorIndices = new Set([hoveredAnchorIndex]);
    }
    refreshAnchorMonitor();
    redraw();
    return;
  }

  marqueeSelection = {
    start: point,
    end: point,
    additive: keyIsDown(SHIFT),
  };
  redraw();
}

function updateSelectionMarquee() {
  if (!marqueeSelection) {
    return;
  }

  const point = getMousePointMM();
  if (!point) {
    return;
  }

  marqueeSelection.end = point;
  redraw();
}

function finalizeSelectionMarquee() {
  if (!marqueeSelection) {
    return;
  }

  const rect = getSelectionRect(marqueeSelection.start, marqueeSelection.end);
  const isClickSelection = rect.w <= 0.2 && rect.h <= 0.2;
  if (!marqueeSelection.additive) {
    selectedAnchorIndices = new Set();
  }

  if (!isClickSelection) {
    const activeFlatIndices = new Set(getFlatIndicesForSpine(activeSpineIdx));
    for (let i = 0; i < spinePoints.length; i += 1) {
      const point = spinePoints[i];
      if (!point || !activeFlatIndices.has(i)) {
        continue;
      }
      if (isPointInsideRect(point, rect)) {
        selectedAnchorIndices.add(i);
      }
    }
  }

  marqueeSelection = null;
  refreshAnchorMonitor();
  redraw();
}

function getSelectionRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function isPointInsideRect(point, rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

function toggleAnchorSelection(index) {
  if (selectedAnchorIndices.has(index)) {
    selectedAnchorIndices.delete(index);
    return;
  }
  selectedAnchorIndices.add(index);
}

function handleArrowKeyMove() {
  const step = getActiveGridStepMM();
  let dx = 0;
  let dy = 0;

  if (keyCode === LEFT_ARROW) {
    dx = -step;
  } else if (keyCode === RIGHT_ARROW) {
    dx = step;
  } else if (keyCode === UP_ARROW) {
    dy = -step;
  } else if (keyCode === DOWN_ARROW) {
    dy = step;
  } else {
    return false;
  }

  const orderedIndices = Array.from(selectedAnchorIndices).sort((a, b) => a - b);
  for (const index of orderedIndices) {
    const point = spinePoints[index];
    if (!point) {
      continue;
    }
    spinePoints[index] = {
      x: constrain(point.x + dx, 0, P.canvasWMM),
      y: constrain(point.y + dy, 0, P.canvasHMM),
    };
  }

  invalidateGeometry();
  refreshAnchorMonitor();
  redraw();
  return true;
}

function shiftSelectedIndicesAfterRemoval(removedIndex) {
  const nextSelection = new Set();
  for (const index of selectedAnchorIndices) {
    if (index < removedIndex) {
      nextSelection.add(index);
    } else if (index > removedIndex) {
      nextSelection.add(index - 1);
    }
  }
  selectedAnchorIndices = nextSelection;
}

function updateHoveredAnchor() {
  hoveredAnchorMeta = findHoveredAnchorMeta();
  hoveredAnchorIndex = hoveredAnchorMeta.flatIdx;
}

function findHoveredAnchorMeta() {
  const point = getMousePointMM();
  if (!point) {
    return { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  }

  const threshold = Math.max(P.hoverRadiusMM, P.anchorRadiusMM);
  const thresholdSq = threshold * threshold;
  let closest = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  let closestDistSq = Infinity;
  let spineIdx = 0;
  let anchorIdx = 0;

  for (let i = 0; i < spinePoints.length; i += 1) {
    const anchor = spinePoints[i];
    if (!anchor) {
      spineIdx += 1;
      anchorIdx = 0;
      continue;
    }
    const dx = anchor.x - point.x;
    const dy = anchor.y - point.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= thresholdSq && distSq < closestDistSq) {
      closest = { spineIdx, anchorIdx, flatIdx: i };
      closestDistSq = distSq;
    }
    anchorIdx += 1;
  }

  return closest;
}

function getOrbitOffset(phase, amplitude, distance, pitch, orbitMode = P.orbitMode) {
  switch (orbitMode) {
    case "cosine":
      return Math.cos(phase) * amplitude;
    case "triangle":
      return triangleWave(phase) * amplitude;
    case "square":
      return Math.sign(Math.sin(phase)) * amplitude;
    case "saw":
      return sawWave(phase) * amplitude;
    case "lissajous":
      return (0.7 * Math.sin(phase) + 0.3 * Math.sin(phase * 3)) * amplitude;
    case "damped":
      return Math.sin(phase) * amplitude * (0.75 + 0.25 * Math.cos((distance / pitch) * Math.PI));
    case "sine":
    default:
      return Math.sin(phase) * amplitude;
  }
}

function triangleWave(phase) {
  return (2 / Math.PI) * Math.asin(Math.sin(phase));
}

function sawWave(phase) {
  const normalized = phase / TWO_PI_VALUE;
  return 2 * (normalized - Math.floor(normalized + 0.5));
}

function buildPane() {
  pane = new Tweakpane.Pane({
    container: document.getElementById("pane"),
    title: "Spiral Spring",
  });

  const canvasFolder = pane.addFolder({ title: "Canvas (mm)" });
  canvasFolder
    .addInput(P, "paperPreset", {
      options: Object.keys(PAPER_PRESETS_MM).reduce((acc, label) => {
        acc[label] = label;
        return acc;
      }, {}),
      label: "Paper",
    })
    .on("change", (ev) => {
      applyPaperPreset(ev.value);
      pane.refresh();
      syncCanvasSize();
      redraw();
    });
  canvasFolder.addInput(P, "canvasWMM", { min: 20, max: 2000, step: 1, label: "W mm" });
  canvasFolder.addInput(P, "canvasHMM", { min: 20, max: 2000, step: 1, label: "H mm" });
  canvasFolder.addInput(P, "dpi", { min: 36, max: 600, step: 1, label: "DPI" });
  canvasFolder.addInput(P, "previewScale", { min: 0.1, max: 8, step: 0.1, label: "Zoom" });
  canvasFolder.addInput(P, "fitToViewport", { label: "Fit View" });

  gridFolder = pane.addFolder({ title: "Base Grid" });
  gridFolder
    .addInput(P, "gridType", {
      options: {
        square: "square",
        hexagonal: "hexagonal",
        "slanted cursive": "slantedCursive",
      },
      label: "Type",
    })
    .on("change", () => {
      rebuildGridTypeControls();
      pane.refresh();
      redraw();
    });
  gridFolder.addInput(P, "snapToGrid", { label: "Snap" });
  gridFolder.addInput(P, "showGrid", { label: "Show Grid" });
  rebuildGridTypeControls();

  const presetFolder = pane.addFolder({ title: "Spine Presets" });
  presetFolder.addInput(P, "presetMode", {
    options: {
      none: "none",
      spaceFill: "spaceFill",
      seedCurve: "seedCurve",
      seedFill: "seedFill",
      hamiltonian: "hamiltonian",
    },
    label: "Preset",
  });
  presetFolder.addInput(P, "presetInsetMM", {
    min: 0,
    max: 100,
    step: 1,
    label: "Inset",
  });
  presetFolder.addInput(P, "presetCols", {
    min: 2,
    max: 40,
    step: 1,
    label: "Cols",
  });
  presetFolder.addInput(P, "presetRows", {
    min: 2,
    max: 40,
    step: 1,
    label: "Rows",
  });
  presetFolder.addInput(P, "presetSeed", {
    min: 0,
    max: 999999,
    step: 1,
    label: "Seed",
  });
  presetFolder.addInput(P, "presetPointCount", {
    min: 2,
    max: 400,
    step: 1,
    label: "Points",
  });
  presetFolder.addInput(P, "presetTurnBias", {
    min: 0,
    max: 10,
    step: 0.1,
    label: "Turn Bias",
  });
  presetFolder.addInput(P, "presetStraightPenalty", {
    min: 0,
    max: 10,
    step: 0.1,
    label: "Straight Pen",
  });
  presetFolder.addButton({ title: "New Seed" }).on("click", () => {
    if (P.presetMode === "none") {
      return;
    }
    P.presetSeed = Math.floor(Math.random() * 1000000);
    pane.refresh();
    applyPreset();
  });
  presetFolder.addButton({ title: "Apply Preset" }).on("click", applyPreset);

  const styleFolder = pane.addFolder({ title: "Style" });
  styleFolder.addInput(P, "bg", { label: "BG" });
  styleFolder.addInput(P, "springColor", { label: "Spring" });
  styleFolder.addInput(P, "spineColor", { label: "Spine" });
  styleFolder.addInput(P, "anchorColor", { label: "Anchors" });
  styleFolder.addInput(P, "hoverColor", { label: "Hover" });
  styleFolder.addInput(P, "gridColor", { label: "Grid" });
  styleFolder.addInput(P, "springStrokeMM", {
    min: 0.05,
    max: 10,
    step: 0.05,
    label: "Spring W",
  });
  styleFolder.addInput(P, "spineStrokeMM", {
    min: 0.05,
    max: 10,
    step: 0.05,
    label: "Spine W",
  });
  styleFolder.addInput(P, "anchorRadiusMM", {
    min: 0.2,
    max: 20,
    step: 0.1,
    label: "Anchor R",
  });
  styleFolder.addInput(P, "hoverRadiusMM", {
    min: 0.2,
    max: 24,
    step: 0.1,
    label: "Hover R",
  });
  styleFolder.addInput(P, "showSpine", { label: "Show Spine" });
  styleFolder.addInput(P, "showAnchors", { label: "Show Anchors" });

  const exportFolder = pane.addFolder({ title: "Export" });
  exportFolder.addInput(P, "svgFilename", { label: "Filename" });
  exportFolder.addButton({ title: "Reset Zoom" }).on("click", () => {
    P.previewScale = 1;
    P.fitToViewport = true;
    pane.refresh();
    updateCanvasDisplaySize();
  });

  anchorFolder = pane.addFolder({ title: "Spine" });
  refreshAnchorMonitor();

  pane.on("change", () => {
    syncPaperPresetFromSize();
    invalidateGeometry();
    syncCanvasSize();
    redraw();
  });
}

function hookUI() {
  document.getElementById("undoBtn").addEventListener("click", () => {
    removeLastSpinePoint();
    syncSpineStylesWithSegments();
    refreshAnchorMonitor();
    invalidateGeometry();
    redraw();
  });

  document.getElementById("clearBtn").addEventListener("click", () => {
    clearActiveSpine();
    selectedAnchorIndices = new Set();
    marqueeSelection = null;
    hoveredAnchorIndex = -1;
    draggedAnchorIndex = -1;
    hoveredAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
    draggedAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
    refreshAnchorMonitor();
    invalidateGeometry();
    redraw();
  });

  document.getElementById("svgBtn").addEventListener("click", () => {
    exportSVG();
  });

  document.getElementById("spineSvgBtn").addEventListener("click", () => {
    exportSpineSVG();
  });

  const wrap = document.getElementById("wrap");
  wrap.addEventListener(
    "wheel",
    (event) => {
      if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const delta = event.deltaY > 0 ? 0.9 : 1.1;
      applyPreviewZoom(delta, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    { passive: false }
  );

  wrap.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 2) {
        pinchGestureState = null;
        return;
      }
      event.preventDefault();
      pinchGestureState = getPinchGestureSnapshot(event.touches);
    },
    { passive: false }
  );

  wrap.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length !== 2) {
        pinchGestureState = null;
        return;
      }
      event.preventDefault();
      const nextGesture = getPinchGestureSnapshot(event.touches);
      if (!pinchGestureState || pinchGestureState.distance <= 0 || nextGesture.distance <= 0) {
        pinchGestureState = nextGesture;
        return;
      }

      const zoomFactor = nextGesture.distance / pinchGestureState.distance;
      applyPreviewZoom(zoomFactor, nextGesture.center);
      pinchGestureState = nextGesture;
    },
    { passive: false }
  );

  wrap.addEventListener("touchend", () => {
    pinchGestureState = null;
  });
  wrap.addEventListener("touchcancel", () => {
    pinchGestureState = null;
  });

  window.addEventListener("resize", updateCanvasDisplaySize);
}

function getPinchGestureSnapshot(touches) {
  const first = touches[0];
  const second = touches[1];
  return {
    distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
    center: {
      clientX: (first.clientX + second.clientX) * 0.5,
      clientY: (first.clientY + second.clientY) * 0.5,
    },
  };
}

function applyPreviewZoom(multiplier, pointer) {
  if (!cnv || !pointer || !Number.isFinite(multiplier) || multiplier <= 0) {
    return;
  }

  const wrap = document.getElementById("wrap");
  const previousRect = cnv.elt.getBoundingClientRect();
  const previousScale = P.previewScale;
  const nextScale = constrain(previousScale * multiplier, 0.1, 10);
  if (Math.abs(nextScale - previousScale) < 0.0001) {
    return;
  }

  const relativeX = previousRect.width > 0 ? (pointer.clientX - previousRect.left) / previousRect.width : 0.5;
  const relativeY = previousRect.height > 0 ? (pointer.clientY - previousRect.top) / previousRect.height : 0.5;

  P.previewScale = nextScale;
  P.fitToViewport = false;
  pane.refresh();
  updateCanvasDisplaySize();

  const nextRect = cnv.elt.getBoundingClientRect();
  wrap.scrollLeft += (nextRect.width - previousRect.width) * relativeX;
  wrap.scrollTop += (nextRect.height - previousRect.height) * relativeY;
  redraw();
}

function refreshAnchorMonitor() {
  if (!anchorFolder) {
    return;
  }

  anchorFolder.dispose();
  const segments = getSpineSegments();
  const pointCount = spinePoints.filter(Boolean).length;
  const activePoints = segments[activeSpineIdx] || [];
  const activeStyle = spineStyles[activeSpineIdx] || createSpineStyle();
  anchorFolder = pane.addFolder({ title: `Active Spine (${activeSpineIdx + 1})` });
  anchorFolder.addMonitor({ count: Math.max(segments.length, spineStyles.length) }, "count", {
    label: "Spines",
  });
  anchorFolder.addMonitor({ pointCount }, "pointCount", { label: "Points" });
  anchorFolder.addMonitor({ selectedCount: selectedAnchorIndices.size }, "selectedCount", {
    label: "Selected",
  });

  const layersFolder = anchorFolder.addFolder({ title: "Layers" });
  if (segments.length === 0) {
    layersFolder.addMonitor({ empty: "No spines yet" }, "empty", { label: "State" });
  } else {
    segments.forEach((segment, index) => {
      const isActive = index === activeSpineIdx;
      const label = `${isActive ? "●" : "○"} Spine ${index + 1} (${segment.length} pts)`;
      layersFolder.addButton({ title: label }).on("click", () => {
        setActiveSpine(index);
      });
    });
  }

  const colorFolder = anchorFolder.addFolder({ title: "Colors" });
  colorFolder.addInput(activeStyle, "springColor", { label: "Spring" });
  colorFolder.addInput(activeStyle, "spineColor", { label: "Spine" });
  colorFolder.addInput(activeStyle, "anchorColor", { label: "Anchors" });

  const springFolder = anchorFolder.addFolder({ title: "Spring Settings" });
  springFolder.addInput(activeStyle, "orbitMode", {
    options: {
      sine: "sine",
      cosine: "cosine",
      triangle: "triangle",
      square: "square",
      saw: "saw",
      lissajous: "lissajous",
      damped: "damped",
      arcTurns: "arcTurns",
      offsetPaths: "offsetPaths",
      blackLetter: "blackLetter",
    },
    label: "Orbit",
  });
  springFolder.addInput(activeStyle, "coilAmplitudeMM", {
    min: 0,
    max: 80,
    step: 0.1,
    label: "Amplitude",
  });
  springFolder.addInput(activeStyle, "coilPitchMM", { min: 1, max: 100, step: 0.1, label: "Pitch" });
  springFolder.addInput(activeStyle, "samplesPerTurn", {
    min: 8,
    max: 240,
    step: 1,
    label: "Samples",
  });
  springFolder.addInput(activeStyle, "offsetLineCount", {
    min: 1,
    max: 40,
    step: 1,
    label: "Num Lines",
  });
  springFolder.addInput(activeStyle, "offsetGapMM", {
    min: 0,
    max: 40,
    step: 0.1,
    label: "Gap",
  });
  springFolder.addInput(activeStyle, "spineSmoothing", {
    min: 0,
    max: 5,
    step: 1,
    label: "Corners",
  });
  springFolder.addInput(activeStyle, "spineSampleStepMM", {
    min: 0.25,
    max: 10,
    step: 0.25,
    label: "Sample Step",
  });
  springFolder.addInput(activeStyle, "springArcRadiusMM", {
    min: 0,
    max: 80,
    step: 0.1,
    label: "Arc Radius",
  });
  springFolder.addInput(activeStyle, "blackLetterAngleDeg", {
    min: -180,
    max: 180,
    step: 1,
    label: "Nib Angle",
  });
  springFolder.addInput(activeStyle, "blackLetterNibWidthMM", {
    min: 0.1,
    max: 80,
    step: 0.1,
    label: "Nib Width",
  });
  springFolder.addInput(activeStyle, "showSpring", { label: "Show Spring" });

  const preview = activePoints
    .slice(0, 8)
    .map((point, index) => `${index + 1}: ${fmt(point.x)}, ${fmt(point.y)}`)
    .join(" | ");
  const state = {
    preview: preview || "Click canvas to add snapped points",
  };
  anchorFolder.addMonitor(state, "preview", {
    label: "Anchors",
    multiline: true,
    lineCount: 4,
  });
}

function exportSVG() {
  ensureGeometryCache();
  const segments = getSpineSegments();
  const svg = [];

  svg.push('<?xml version="1.0" encoding="UTF-8"?>');
  svg.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(P.canvasWMM)}mm" height="${fmt(
      P.canvasHMM
    )}mm" viewBox="0 0 ${fmt(P.canvasWMM)} ${fmt(P.canvasHMM)}">`
  );
  svg.push(
    `<rect x="0" y="0" width="${fmt(P.canvasWMM)}" height="${fmt(P.canvasHMM)}" fill="${escapeXML(
      P.bg
    )}"/>`
  );

  if (P.showGrid) {
    svg.push(
      `<g stroke="${escapeXML(P.gridColor)}" stroke-width="0.2" fill="none" opacity="0.85">`
    );
    forEachGridLine(P.canvasWMM, P.canvasHMM, (lineDef) => {
      svg.push(
        `<line x1="${fmt(lineDef.x1)}" y1="${fmt(lineDef.y1)}" x2="${fmt(lineDef.x2)}" y2="${fmt(
          lineDef.y2
        )}"/>`
      );
    });
    svg.push("</g>");
  }

  if (P.showSpine) {
    for (let segmentIndex = 0; segmentIndex < cachedRenderSpinePaths.length; segmentIndex += 1) {
      const renderPath = cachedRenderSpinePaths[segmentIndex];
      const style = spineStyles[segmentIndex] || createSpineStyle();
      if (renderPath.length < 2) {
        continue;
      }
      svg.push(
        `<path d="${polylineToPath(renderPath)}" fill="none" stroke="${escapeXML(
          style.spineColor
        )}" stroke-width="${fmt(P.spineStrokeMM)}"/>`
      );
    }
  }

  if (spineStyles.some((style) => (style || createSpineStyle()).showSpring)) {
    for (let segmentIndex = 0; segmentIndex < cachedSpringPaths.length; segmentIndex += 1) {
      const style = spineStyles[segmentIndex] || createSpineStyle();
      if (!style.showSpring) {
        continue;
      }
      for (const springPath of cachedSpringPaths[segmentIndex]) {
        if (springPath.length < 2) {
          continue;
        }
        svg.push(
          `<path d="${polylineToPath(springPath)}" fill="none" stroke="${escapeXML(
            style.springColor
          )}" stroke-width="${fmt(P.springStrokeMM)}"/>`
        );
      }
    }
  }

  if (P.showAnchors) {
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const style = spineStyles[segmentIndex] || createSpineStyle();
      svg.push(`<g fill="${escapeXML(style.anchorColor)}" stroke="none">`);
      for (const point of segments[segmentIndex]) {
        svg.push(
          `<circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="${fmt(P.anchorRadiusMM)}"/>`
        );
      }
      svg.push("</g>");
    }
  }

  svg.push("</svg>");
  downloadText(svg.join("\n"), P.svgFilename, "image/svg+xml");
}

function exportSpineSVG() {
  ensureGeometryCache();
  if (cachedRenderSpinePaths.length === 0) {
    return;
  }

  const filename = getSpineSvgFilename();
  const svg = [];
  svg.push('<?xml version="1.0" encoding="UTF-8"?>');
  svg.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(P.canvasWMM)}mm" height="${fmt(
      P.canvasHMM
    )}mm" viewBox="0 0 ${fmt(P.canvasWMM)} ${fmt(P.canvasHMM)}">`
  );
  for (let segmentIndex = 0; segmentIndex < cachedRenderSpinePaths.length; segmentIndex += 1) {
    const renderPath = cachedRenderSpinePaths[segmentIndex];
    if (renderPath.length < 2) {
      continue;
    }
    const style = spineStyles[segmentIndex] || createSpineStyle();
    svg.push(
      `<path d="${polylineToPath(renderPath)}" fill="none" stroke="${escapeXML(
        style.spineColor
      )}" stroke-width="${fmt(P.spineStrokeMM)}"/>`
    );
  }
  svg.push("</svg>");
  downloadText(svg.join("\n"), filename, "image/svg+xml");
}

function getSpineSegments() {
  const segments = [];
  let current = [];

  for (const point of spinePoints) {
    if (!point) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(point);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function getLastSpinePoint() {
  for (let i = spinePoints.length - 1; i >= 0; i -= 1) {
    if (spinePoints[i]) {
      return spinePoints[i];
    }
    if (spinePoints[i] === null) {
      break;
    }
  }
  return null;
}

function startNewSpine() {
  const last = spinePoints[spinePoints.length - 1];
  const hasAnyPoints = spinePoints.some(Boolean);
  if (!hasAnyPoints || last === null) {
    return;
  }

  spinePoints.push(null);
  spineStyles.push(createSpineStyle());
  activeSpineIdx = spineStyles.length - 1;
  selectedAnchorIndices = new Set();
  hoveredAnchorIndex = -1;
  draggedAnchorIndex = -1;
  hoveredAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  draggedAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  invalidateGeometry();
  refreshAnchorMonitor();
  redraw();
}

function removeLastSpinePoint() {
  while (spinePoints.length > 0 && spinePoints[spinePoints.length - 1] === null) {
    spinePoints.pop();
  }

  if (spinePoints.length === 0) {
    return;
  }

  const removedIndex = spinePoints.length - 1;
  spinePoints.pop();
  selectedAnchorIndices.delete(removedIndex);
  shiftSelectedIndicesAfterRemoval(removedIndex);

  while (spinePoints.length > 0 && spinePoints[spinePoints.length - 1] === null) {
    spinePoints.pop();
  }
  syncSpineStylesWithSegments();
}

function getSpineSvgFilename() {
  if (typeof P.svgFilename !== "string" || P.svgFilename.trim() === "") {
    return "Spiral-Spring-Path-spine.svg";
  }

  if (P.svgFilename.toLowerCase().endsWith(".svg")) {
    return `${P.svgFilename.slice(0, -4)}-spine.svg`;
  }

  return `${P.svgFilename}-spine.svg`;
}

function createSpineStyle() {
  return {
    springColor: P.springColor,
    spineColor: P.spineColor,
    anchorColor: P.anchorColor,
    orbitMode: P.orbitMode,
    coilAmplitudeMM: P.coilAmplitudeMM,
    coilPitchMM: P.coilPitchMM,
    samplesPerTurn: P.samplesPerTurn,
    spineSmoothing: P.spineSmoothing,
    spineSampleStepMM: P.spineSampleStepMM,
    offsetLineCount: P.offsetLineCount,
    offsetGapMM: P.offsetGapMM,
    blackLetterAngleDeg: P.blackLetterAngleDeg,
    blackLetterNibWidthMM: P.blackLetterNibWidthMM,
    springArcRadiusMM: P.springArcRadiusMM,
    showSpring: P.showSpring,
  };
}

function setActiveSpine(index) {
  const segmentCount = getSpineSegments().length;
  activeSpineIdx = constrain(index, 0, Math.max(0, segmentCount - 1));
  selectedAnchorIndices = new Set();
  hoveredAnchorIndex = -1;
  draggedAnchorIndex = -1;
  hoveredAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  draggedAnchorMeta = { spineIdx: -1, anchorIdx: -1, flatIdx: -1 };
  refreshAnchorMonitor();
  redraw();
}

function syncSpineStylesWithSegments() {
  const segmentCount = getSpineSegments().length;
  while (spineStyles.length < segmentCount) {
    spineStyles.push(createSpineStyle());
  }
  if (spineStyles.length > segmentCount) {
    spineStyles.length = segmentCount;
  }
  activeSpineIdx = constrain(activeSpineIdx, 0, Math.max(0, segmentCount - 1));
}

function replaceActiveSpinePoints(nextPoints) {
  const replacement = Array.isArray(nextPoints) ? nextPoints.map(copyPoint) : [];
  const range = getFlatRangeForSpine(activeSpineIdx);
  if (!range) {
    spinePoints.length = 0;
    spinePoints.push(...replacement);
    return;
  }

  const before = spinePoints.slice(0, range.start);
  const after = spinePoints.slice(range.end + 1);
  spinePoints.length = 0;
  spinePoints.push(...before, ...replacement, ...after);
}

function clearActiveSpine() {
  const segmentCount = getSpineSegments().length;
  if (segmentCount <= 1) {
    spinePoints.length = 0;
    spineStyles = [createSpineStyle()];
    activeSpineIdx = 0;
    return;
  }

  const range = getFlatRangeForSpine(activeSpineIdx);
  if (!range) {
    return;
  }

  let removeStart = range.start;
  let removeEnd = range.end;
  if (removeEnd + 1 < spinePoints.length && spinePoints[removeEnd + 1] === null) {
    removeEnd += 1;
  } else if (removeStart > 0 && spinePoints[removeStart - 1] === null) {
    removeStart -= 1;
  }

  spinePoints.splice(removeStart, removeEnd - removeStart + 1);
  spineStyles.splice(activeSpineIdx, 1);
  activeSpineIdx = constrain(activeSpineIdx, 0, Math.max(0, spineStyles.length - 1));
  syncSpineStylesWithSegments();
}

function getFlatRangeForSpine(targetSpineIdx) {
  let spineIdx = 0;
  let start = -1;
  let end = -1;

  for (let i = 0; i < spinePoints.length; i += 1) {
    const point = spinePoints[i];
    if (point === null) {
      if (spineIdx === targetSpineIdx) {
        break;
      }
      spineIdx += 1;
      continue;
    }

    if (spineIdx === targetSpineIdx) {
      if (start < 0) {
        start = i;
      }
      end = i;
    }
  }

  if (start < 0) {
    if (targetSpineIdx === spineStyles.length - 1) {
      return { start: spinePoints.length, end: spinePoints.length - 1 };
    }
    return null;
  }

  return { start, end };
}

function getFlatIndicesForSpine(targetSpineIdx) {
  const indices = [];
  let spineIdx = 0;
  for (let i = 0; i < spinePoints.length; i += 1) {
    const point = spinePoints[i];
    if (!point) {
      spineIdx += 1;
      continue;
    }
    if (spineIdx === targetSpineIdx) {
      indices.push(i);
    }
  }
  return indices;
}

function polylineToPath(points) {
  if (points.length === 0) {
    return "";
  }

  let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 1; i < points.length; i += 1) {
    d += ` L ${fmt(points[i].x)} ${fmt(points[i].y)}`;
  }
  return d;
}

function isPointerInsideCanvas() {
  return mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height;
}

function getMousePointMM() {
  const pxPerMM = getPxPerMM();
  if (pxPerMM <= 0 || !isPointerInsideCanvas()) {
    return null;
  }

  return {
    x: mouseX / pxPerMM,
    y: mouseY / pxPerMM,
  };
}

function getSnappedMousePointMM() {
  const point = getMousePointMM();
  if (!point) {
    return null;
  }

  let xMM = point.x;
  let yMM = point.y;

  if (P.snapToGrid) {
    const snapped = snapPointToActiveGrid({ x: xMM, y: yMM });
    xMM = snapped.x;
    yMM = snapped.y;
  }

  return {
    x: constrain(xMM, 0, P.canvasWMM),
    y: constrain(yMM, 0, P.canvasHMM),
  };
}

function syncCanvasSize() {
  const size = getCanvasPixelSize();
  resizeCanvas(size.width, size.height, true);
  updateCanvasDisplaySize();
}

function updateCanvasDisplaySize() {
  if (!cnv) {
    return;
  }

  const wrap = document.getElementById("wrap");
  const rect = wrap.getBoundingClientRect();
  const pxSize = getCanvasPixelSize();
  const padding = 24;
  const availableW = Math.max(1, rect.width - padding);
  const availableH = Math.max(1, rect.height - padding);
  const fitScale = Math.min(availableW / pxSize.width, availableH / pxSize.height, 1);
  const zoomScale = Math.max(0.05, P.previewScale);
  const unclampedScale = P.fitToViewport ? fitScale * zoomScale : zoomScale;
  const scale = P.fitToViewport ? Math.min(fitScale, unclampedScale) : unclampedScale;
  currentDisplayScale = Math.max(0.01, scale);
  const displayW = Math.max(1, Math.round(pxSize.width * scale));
  const displayH = Math.max(1, Math.round(pxSize.height * scale));

  cnv.style("width", `${displayW}px`);
  cnv.style("height", `${displayH}px`);
}

function getPxPerMM() {
  return P.dpi / MM_PER_INCH;
}

function rebuildGridTypeControls() {
  if (!gridFolder) {
    return;
  }
  normalizeGridTypeValue();
  for (const blade of gridTypeControlBlades) {
    blade.dispose();
  }
  gridTypeControlBlades = [];

  if (P.gridType === "hexagonal") {
    gridTypeControlBlades.push(
      gridFolder.addInput(P, "hexGridSizeMM", { min: 1, max: 60, step: 0.5, label: "Hex Size" })
    );
    return;
  }

  if (P.gridType === "slantedCursive") {
    gridTypeControlBlades.push(
      gridFolder.addInput(P, "cursiveSpacingMM", {
        min: 1,
        max: 60,
        step: 0.5,
        label: "Spacing",
      })
    );
    gridTypeControlBlades.push(
      gridFolder.addInput(P, "cursiveSlantDeg", { min: 10, max: 140, step: 1, label: "Slant" })
    );
    gridTypeControlBlades.push(
      gridFolder.addInput(P, "cursiveMajorEvery", {
        min: 1,
        max: 12,
        step: 1,
        label: "Major Every",
      })
    );
    return;
  }

  gridTypeControlBlades.push(
    gridFolder.addInput(P, "gridSpacingMM", { min: 1, max: 100, step: 0.5, label: "Grid" })
  );
}

function normalizeGridTypeValue() {
  if (P.gridType === "slanted cursive") {
    P.gridType = "slantedCursive";
    return;
  }
  if (P.gridType === "hex") {
    P.gridType = "hexagonal";
    return;
  }
  if (P.gridType !== "square" && P.gridType !== "hexagonal" && P.gridType !== "slantedCursive") {
    P.gridType = "square";
  }
}

function getActiveGridStepMM() {
  if (P.gridType === "hexagonal") {
    return Math.max(0.5, P.hexGridSizeMM);
  }
  if (P.gridType === "slantedCursive") {
    return Math.max(0.5, P.cursiveSpacingMM);
  }
  return Math.max(0.5, P.gridSpacingMM);
}

function snapPointToActiveGrid(point) {
  if (P.gridType === "hexagonal") {
    return snapPointToHexGrid(point);
  }
  if (P.gridType === "slantedCursive") {
    return snapPointToCursiveGrid(point);
  }
  const spacing = Math.max(0.5, P.gridSpacingMM);
  return {
    x: Math.round(point.x / spacing) * spacing,
    y: Math.round(point.y / spacing) * spacing,
  };
}

function snapPointToHexGrid(point) {
  const size = Math.max(0.5, P.hexGridSizeMM);
  const sqrt3 = Math.sqrt(3);
  const q = (sqrt3 / 3 / size) * point.x - (1 / 3 / size) * point.y;
  const r = (2 / 3 / size) * point.y;
  const rounded = roundAxialHex(q, r);
  return {
    x: size * sqrt3 * (rounded.q + rounded.r / 2),
    y: size * 1.5 * rounded.r,
  };
}

function roundAxialHex(q, r) {
  let x = q;
  let z = r;
  let y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
}

function snapPointToCursiveGrid(point) {
  const spacing = Math.max(0.5, P.cursiveSpacingMM);
  const slantDeg = constrain(P.cursiveSlantDeg, 10, 140);
  const slantRad = (slantDeg * Math.PI) / 180;
  const sinA = Math.sin(slantRad);
  const cosA = Math.cos(slantRad);

  const y = Math.round(point.y / spacing) * spacing;
  if (Math.abs(sinA) < 1e-6) {
    return { x: point.x, y };
  }

  const nX = -sinA;
  const nY = cosA;
  const normalDistance = point.x * nX + point.y * nY;
  const snappedNormal = Math.round(normalDistance / spacing) * spacing;
  const x = (cosA * y - snappedNormal) / sinA;

  return { x, y };
}

function getPaperSizeMM() {
  const pxPerMM = Math.max(0.0001, getPxPerMM());
  return {
    width: width / pxPerMM,
    height: height / pxPerMM,
  };
}

function applyPaperPreset(presetName) {
  const preset = PAPER_PRESETS_MM[presetName];
  if (!preset) {
    return;
  }

  P.canvasWMM = preset.w;
  P.canvasHMM = preset.h;
}

function syncPaperPresetFromSize() {
  for (const [name, preset] of Object.entries(PAPER_PRESETS_MM)) {
    if (!preset) {
      continue;
    }
    if (nearlyEqual(P.canvasWMM, preset.w) && nearlyEqual(P.canvasHMM, preset.h)) {
      P.paperPreset = name;
      return;
    }
  }
  P.paperPreset = "Custom";
}

function mmToPx(mm) {
  return Math.max(1, Math.round(mm * getPxPerMM()));
}

function getCanvasPixelSize() {
  return {
    width: mmToPx(P.canvasWMM),
    height: mmToPx(P.canvasHMM),
  };
}

function fmt(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "");
}

function nearlyEqual(a, b) {
  return Math.abs(a - b) < 0.0001;
}

function copyPoint(point) {
  return { x: point.x, y: point.y };
}

function escapeXML(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let value = Math.imul(t ^ (t >>> 15), t | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
