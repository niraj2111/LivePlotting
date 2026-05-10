# Sketches

This folder is for custom stream-input sketches that send SVG into the running saxi server.

## Structure

- `../saxi-main/` is the core saxi app
- `../shared/` contains reusable helpers for connecting to saxi and exporting SVG
- each subfolder here is its own standalone sketch

## Included sketches

- `basic-stream/` - minimal starter sketch
- `calligraphyPad/` - standalone version of the richer calligraphy stream pad
- `spring-path/` - spiral spring path streamer

## Run

1. Start saxi from `../saxi-main`
2. Serve any sketch folder with a static server
3. Open that sketch in the browser
4. The sketch connects to `ws://localhost:9080/chat`

Example:

```bash
cd /Users/niraj/Documents/GitHub/LivePlotting/sketches/basic-stream
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000).
