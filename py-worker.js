importScripts("https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js");
let pyodideReady = null;
let pyodide = null;
let inputSAB = null; // set via an "init-input" message if the page is cross-origin isolated

// Pyodide's "batched" stdout mode only calls back once a full line (ending
// in \n) has been written, buffering anything before that internally. An
// input() prompt like input("enter") has NO trailing newline, so it would
// sit stuck in that buffer — invisible — until some later print() finally
// supplies a newline, at which point everything buffered so far dumps out
// together, jumbled. Using "raw" (byte-level) stdout instead, with our own
// buffer that we can flush on demand, lets us guarantee the prompt text is
// flushed to the screen immediately, before we block waiting for the answer.
let outBuf = [];
let outFlushScheduled = false;
const outDecoder = new TextDecoder();
function flushOut(){
  outFlushScheduled = false;
  if (!outBuf.length) return;
  const bytes = new Uint8Array(outBuf);
  outBuf = [];
  self.postMessage({ type: "print", chunk: outDecoder.decode(bytes, { stream: true }) });
}
function rawWrite(byte){
  outBuf.push(byte);
  if (!outFlushScheduled) {
    outFlushScheduled = true;
    setTimeout(flushOut, 0); // batches a burst of writes (e.g. one print() call) into one message
  }
}

function requestInputSync(){
  if (!inputSAB) return null; // no SharedArrayBuffer available — falls back to a clean EOFError
  flushOut(); // guarantee the prompt text written just before this call is visible before we block —
              // the scheduled setTimeout above can't run once Atomics.wait freezes this thread
  const signal = new Int32Array(inputSAB, 0, 1);
  const length = new Int32Array(inputSAB, 4, 1);
  const text = new Uint8Array(inputSAB, 8);
  Atomics.store(signal, 0, 0);
  self.postMessage({ type: "input-request" });
  Atomics.wait(signal, 0, 0); // blocks THIS worker thread only — the tab stays responsive
  const len = Atomics.load(length, 0);
  return new TextDecoder().decode(text.slice(0, len));
}

async function boot(){
  pyodide = await loadPyodide();
  pyodide.setStdout({ raw: rawWrite });
  pyodide.setStderr({ raw: rawWrite });
  pyodide.setStdin({ stdin: requestInputSync });
  pyodide.runPython("import ast, json\ndef _physoon_check_syntax(src):\n    try:\n        ast.parse(src)\n        return ''\n    except SyntaxError as e:\n        return json.dumps({'line': e.lineno, 'msg': str(e)})");
  self.postMessage({ type: "ready", isolated: (typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated) });
}
pyodideReady = boot().catch(err => {
  self.postMessage({ type: "boot-error", error: (err && err.message) ? err.message : String(err) });
});

self.onmessage = async function(e){
  if (e.data.type === "init-input") { inputSAB = e.data.buffer; return; }
  if (e.data.type === "check-syntax") {
    await pyodideReady;
    let result = "";
    try { result = pyodide.globals.get("_physoon_check_syntax")(e.data.code); } catch (err) { result = ""; }
    self.postMessage({ type: "syntax-result", result });
    return;
  }
  if (e.data.type !== "run") return;
  try {
    await pyodideReady;
    try { await pyodide.loadPackagesFromImports(e.data.code); } catch (pkgErr) { /* unknown/unavailable package — let the real ImportError surface below */ }
    await pyodide.runPythonAsync(e.data.code);
    flushOut();
    self.postMessage({ type: "done", ok: true });
  } catch (err) {
    flushOut();
    self.postMessage({ type: "done", ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
