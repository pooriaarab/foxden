// Shared by the E2E tests. startProbe runs a local server that records every
// request. probeCode returns Python snippets that try to reach it in every
// way we know. deadProxy sends all remote network to a closed port, so a
// test also proves foxden works offline.
import { createServer } from "node:http";

export async function startProbe() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "access-control-allow-origin": "*" }).end("leak");
  });
  server.on("upgrade", (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { hits, host: `127.0.0.1:${server.address().port}`, close: () => server.close() };
}
export const deadProxy = {
  "network.proxy.type": 1,
  "network.proxy.http": "127.0.0.1",
  "network.proxy.http_port": 9,
  "network.proxy.ssl": "127.0.0.1",
  "network.proxy.ssl_port": 9,
};

export function probeCode(host) {
  const wait = "import asyncio\nawait asyncio.sleep(1)\n";
  return {
    "N1 fetch": `from js import fetch\nawait fetch('http://${host}/fetch')`,
    "N2 XMLHttpRequest": `from js import XMLHttpRequest\nx = XMLHttpRequest.new()\nx.open('GET', 'http://${host}/xhr', False)\nx.send()`,
    "N3 WebSocket": `from js import WebSocket\nw = WebSocket.new('ws://${host}/ws')\n${wait}assert w.readyState == 1, 'not open'`,
    "N4 EventSource": `from js import EventSource\ne = EventSource.new('http://${host}/es')\n${wait}assert e.readyState == 1, 'not open'`,
    "N4 import()": `import js\nawait js.eval("import('http://${host}/import.js')")`,
    "N4 nested worker": `from js import Worker, Blob, URL, Array\nsrc = Array.new("fetch('http://${host}/nested').then(() => postMessage('ok'), (e) => postMessage(String(e)))")\nw = Worker.new(URL.createObjectURL(Blob.new(src)))\n${wait}raise RuntimeError('a nested worker cannot report a result here')`,
  };
}
