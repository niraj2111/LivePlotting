# Spiral Spring Path

Interactive spring-path sketch with:

- millimeter-based canvas controls
- paper size presets (A5/A4/A3 portrait + landscape)
- base grid types: square, hexagonal, slanted cursive
- grid snapping for spine anchors (based on selected grid type)
- click-to-place polyline spine editing
- Hamiltonian spine preset with turn/straight bias tuning
- offset-path spring mode with rounded arc turns
- blackletter brush mode with fixed-angle nib strokes
- preview zoom / fit controls, including trackpad/wheel zoom and pinch-to-zoom
- manual SVG export

## Use

1. Open `index.html` in a static server.
2. Click on the canvas to add snapped spine points.
3. Press `N` to start a new spine.
4. Press `M` to toggle multi-select mode for anchors.
5. Drag a selection box, or hold `Shift` and click anchors to add or remove them.
6. Use arrow keys to move selected anchors by one grid unit.
7. Adjust spring settings in Tweakpane.
8. Use `Export SVG` to save the generated path.

## Notes

- `DPI` only affects raster preview density.
- `Paper` presets set `W mm` and `H mm` instantly; manual size edits switch preset to `Custom`.
- `Base Grid` exposes controls per type:
  - `square`: `Grid`
  - `hexagonal`: `Hex Size`
  - `slanted cursive`: `Spacing`, `Slant`, `Major Every`
- SVG output is exported in `mm`.
- `Export Spine SVG` downloads just the spine as an SVG path.
- `N` starts a new spine while keeping the existing spines on the canvas.
- `M` toggles marquee selection mode for anchors.
- `offsetPaths` draws multiple continuous offset lines along the spine using `Num Lines`, `Gap`, and `Arc Radius`.
- `arcTurns` keeps the single spring path and rounds its corners with sampled circular arcs.
- `blackLetter` stamps fixed-angle nib lines along the path; `Pitch` controls spacing, and corners do not rotate the nib.
- Zoomed-in previews can be panned by scrolling inside the canvas area.
- The current version supports point creation, undo, and clear.
