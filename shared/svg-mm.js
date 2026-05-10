const SVG_UNITS_PER_MM = 96 / 25.4;

function fmt(n) {
  return Number(n)
    .toFixed(3)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

export function mmToSvgUnits(mm) {
  return mm * SVG_UNITS_PER_MM;
}

export function polylineToSvgPath(points) {
  return points
    .map((pt, index) => {
      const x = mmToSvgUnits(pt.x);
      const y = mmToSvgUnits(pt.y);
      return `${index === 0 ? "M" : "L"} ${fmt(x)} ${fmt(y)}`;
    })
    .join(" ");
}

export function strokesToSvg(strokes, paper) {
  const width = mmToSvgUnits(paper.x);
  const height = mmToSvgUnits(paper.y);
  const paths = strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => `<path d="${polylineToSvgPath(stroke)}" fill="none" stroke="black" stroke-width="1" />`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}">`,
    paths,
    "</svg>",
  ].join("\n");
}
