export function createSaxiClient({
  host = () => window.location.hostname || "localhost",
  port = 9080,
  onStatus = () => {},
  onPaper = () => {},
} = {}) {
  let socket = null;
  let reconnectTimer = null;
  let connected = false;
  let paper = { x: 210, y: 297, marginMm: 20 };

  function emitStatus(text) {
    onStatus(text, connected);
  }

  function socketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const resolvedHost = typeof host === "function" ? host() : host;
    return `${protocol}://${resolvedHost}:${port}/chat`;
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    socket = new WebSocket(socketUrl());

    socket.addEventListener("open", () => {
      connected = true;
      emitStatus("Connected");
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
          onPaper(paper);
        }
      } catch {
        // ignore non-json messages
      }
    });

    socket.addEventListener("close", () => {
      connected = false;
      emitStatus("Disconnected, retrying...");
      reconnectTimer = window.setTimeout(connect, 1000);
    });

    socket.addEventListener("error", () => {
      connected = false;
      emitStatus("Socket error");
    });
  }

  function disconnect() {
    if (reconnectTimer != null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      socket.close();
      socket = null;
    }
  }

  function sendSvg(svg) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      emitStatus("Socket not connected");
      return false;
    }
    socket.send(JSON.stringify({ c: "incoming-svg", p: { svg } }));
    emitStatus(`Streamed at ${new Date().toLocaleTimeString()}`);
    return true;
  }

  function getPaper() {
    return { ...paper };
  }

  function isConnected() {
    return connected;
  }

  return {
    connect,
    disconnect,
    getPaper,
    isConnected,
    sendSvg,
  };
}
