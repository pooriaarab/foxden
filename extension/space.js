// The Space page: drop files into a den, run Python on them, and download
// what the code writes to /out. It uses foxden as any extension would.
import { idbStore, iframeRuntime, openDen } from "../src/index.ts";

const $ = (id) => document.getElementById(id);
const output = $("output");
let den;

function show(text) {
  output.textContent = text;
  output.dataset.done = "1";
}

let links = [];

async function refresh() {
  for (const url of links) URL.revokeObjectURL(url);
  links = [];
  const items = [];
  for (const { path, size } of await den.list()) {
    const li = document.createElement("li");
    li.dataset.path = path;
    li.append(`${path} (${size} B)`);
    if (path.startsWith("/out/")) {
      const a = document.createElement("a");
      a.textContent = "Download";
      a.download = path.slice(5);
      a.href = URL.createObjectURL(new Blob([await den.readFile(path)]));
      links.push(a.href);
      li.append(a);
    }
    items.push(li);
  }
  $("files").replaceChildren(...items);
}

// A file name can hold / or \. Replace them, so each file lands in /drop.
async function addFiles(files) {
  for (const file of files) {
    const name = file.name.replace(/[/\\\0]/g, "_");
    await den.writeFile(`/drop/${name}`, new Uint8Array(await file.arrayBuffer())).catch((error) => show(`${name}: ${error.message}`));
  }
  await refresh();
}

const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  void addFiles(e.dataTransfer.files);
});
$("picker").addEventListener("change", (e) => void addFiles(e.target.files));

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  show("Running...");
  output.dataset.done = "";
  const r = await den.run($("code").value, { timeoutMs: Number($("limit").value) * 1000 });
  const stopped = r.error?.kind === "timeout" ? `Stopped: the code passed the time limit of ${$("limit").value} s.\n` : "";
  const result = r.result !== null && r.result !== "None" ? `-> ${r.result}\n` : "";
  show(`${r.stdout}${r.stderr}${result}${stopped}${r.error && !stopped ? r.error.message : ""}${r.truncated ? "\n[output cut]" : ""}`);
  $("run").disabled = false;
  await refresh();
});

$("sh").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await den.sh($("sh-line").value);
  show(`${r.stdout}${r.stderr}`);
});

async function start() {
  den = await openDen({ name: "space", store: idbStore(), runtime: iframeRuntime({ denUrl: "den/den.html", pyodideUrl: "pyodide/" }) });
  document.body.dataset.isolation = den.info.isolation;
  document.body.dataset.loadMs = String(den.info.loadMs);
  $("status").textContent = `Python is ready (${(den.info.loadMs / 1000).toFixed(1)} s). Isolation: ${den.info.isolation}.`;
  $("run").disabled = false;
  await refresh();
  document.body.dataset.ready = "1";
}

start().catch((error) => {
  $("status").textContent = `Python did not load: ${error.message}`;
});
