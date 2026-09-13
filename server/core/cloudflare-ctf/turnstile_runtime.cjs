const fs = require("fs");
const readline = require("readline");
const { JSDOM, VirtualConsole } = require("jsdom");

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const outer = new JSDOM("<!doctype html><iframe></iframe>", {
  url: input.parentUrl,
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
const frame = outer.window.document.querySelector("iframe");
frame.src = input.url;
const frameDocument = frame.contentDocument;
frameDocument.open();
frameDocument.write(input.html);
frameDocument.close();

const window = frame.contentWindow;
const document = window.document;
const errors = [];
const requests = [];
const parentMessages = [];
const reportedErrors = [];
const pending = new Map();
let requestId = 0;
let finished = false;

function defineValue(target, name, value) {
  try {
    Object.defineProperty(target, name, { configurable: true, value });
  } catch (_) {}
}

defineValue(window.navigator, "userAgent", input.userAgent);
defineValue(window.navigator, "appVersion", input.userAgent.replace(/^Mozilla\//, ""));
const browserIdentity = input.browserIdentity || {};
defineValue(window.navigator, "platform", browserIdentity.platform || "MacIntel");
defineValue(window.navigator, "language", browserIdentity.locale || "zh-CN");
defineValue(window.navigator, "languages", browserIdentity.languages || [browserIdentity.locale || "zh-CN", "zh"]);
window.addEventListener("message", (event) => {
  if (!event.isTrusted) return;
  if (event.source !== outer.window) defineValue(event, "source", outer.window);
  if (!event.origin) defineValue(event, "origin", new URL(input.parentUrl).origin);
}, true);

function evaluate(source, filename) {
  try {
    window.eval(`${source}\n//# sourceURL=${filename}`);
  } catch (error) {
    errors.push(error.stack || String(error));
  }
}

defineValue(window, "__cfPerformanceEntries", input.performanceEntries || []);
evaluate(`(() => {
  const iframeDescriptor = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype, "contentWindow"
  );
  const fallbackFrames = new WeakMap();
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    enumerable: true,
    get: function contentWindow() {
      const nativeWindow = iframeDescriptor.get.call(this);
      if (nativeWindow) return nativeWindow;
      if (fallbackFrames.has(this)) return fallbackFrames.get(this);
      const bridge = document.createElement("iframe");
      bridge.setAttribute("aria-hidden", "true");
      bridge.style.display = "none";
      document.body.appendChild(bridge);
      const bridgeWindow = iframeDescriptor.get.call(bridge);
      fallbackFrames.set(this, bridgeWindow);
      return bridgeWindow;
    },
  });
  const entries = window.__cfPerformanceEntries;
  class PerformanceEntry {}
  class PerformanceResourceTiming extends PerformanceEntry {}
  class PerformanceNavigationTiming extends PerformanceResourceTiming {}
  window.PerformanceEntry = PerformanceEntry;
  window.PerformanceResourceTiming = PerformanceResourceTiming;
  window.PerformanceNavigationTiming = PerformanceNavigationTiming;
  for (const entry of entries) {
    Object.setPrototypeOf(entry, entry.entryType === "navigation"
      ? PerformanceNavigationTiming.prototype
      : PerformanceResourceTiming.prototype);
  }
  const prototype = Object.getPrototypeOf(performance);
  Object.defineProperty(prototype, "getEntries", {
    configurable: true,
    value: function getEntries() { return entries.slice(); },
  });
  Object.defineProperty(prototype, "getEntriesByType", {
    configurable: true,
    value: function getEntriesByType(type) {
      return entries.filter((entry) => entry.entryType === String(type));
    },
  });
  class PerformanceObserver {
    constructor(callback) { this._callback = callback; this._records = []; }
    observe(options) { this._options = options; }
    disconnect() { this._records.length = 0; }
    takeRecords() { return this._records.splice(0); }
  }
  window.PerformanceObserver = PerformanceObserver;
  const objectUrls = new Set();
  URL.createObjectURL = function createObjectURL(blob) {
    if (!(blob instanceof Blob)) throw new TypeError("Overload resolution failed");
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    const url = "blob:" + location.origin + "/" + token;
    objectUrls.add(url);
    return url;
  };
  URL.revokeObjectURL = function revokeObjectURL(url) { objectUrls.delete(String(url)); };
  class Worker extends EventTarget {
    constructor(url, options = {}) {
      super(); this._url = String(url); this._options = options;
      this.onmessage = null; this.onerror = null; this.onmessageerror = null;
    }
    postMessage() {}
    terminate() {}
  }
  window.Worker = Worker;
  class ReadableStream {
    constructor(source = {}, strategy = {}) {
      this.locked = false; this._source = source; this._strategy = strategy;
    }
    cancel() { return Promise.resolve(); }
    getReader() {
      this.locked = true;
      return {
        closed: Promise.resolve(),
        cancel: () => Promise.resolve(),
        read: () => Promise.resolve({ done: true, value: undefined }),
        releaseLock: () => { this.locked = false; },
      };
    }
    pipeThrough(transform) { return transform.readable; }
    pipeTo() { return Promise.resolve(); }
    tee() { return [new ReadableStream(), new ReadableStream()]; }
  }
  window.ReadableStream = ReadableStream;
})()`, "turnstile-bootstrap.js");

defineValue(outer.window, "postMessage", function postMessage(data, targetOrigin) {
  const message = { data, targetOrigin: String(targetOrigin || "") };
  parentMessages.push(message);
  process.stdout.write(`${JSON.stringify({ type: "parent-message", message })}\n`);
});

function record(kind, method, url, body, headers) {
  const item = {
    id: ++requestId,
    kind,
    method: String(method || "GET").toUpperCase(),
    url: new URL(String(url), window.location.href).href,
    body: body == null ? "" : String(body),
    headers: headers || {},
    at: Math.round(window.performance.now()),
  };
  requests.push(item);
  process.stdout.write(`${JSON.stringify({ type: "request", request: item })}\n`);
  return new Promise((resolve) => pending.set(item.id, resolve));
}

function bodyBytes(reply) {
  if (reply.bodyBase64) return Uint8Array.from(Buffer.from(reply.bodyBase64, "base64"));
  return new TextEncoder().encode(reply.body || "");
}

class RuntimeXHR extends window.EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.status = 0;
    this.response = "";
    this.responseText = "";
    this.responseType = "";
    this.responseURL = "";
    this.timeout = 0;
    this._headers = {};
  }
  open(method, url) { this._method = method; this._url = url; this.readyState = 1; }
  setRequestHeader(name, value) { this._headers[String(name)] = String(value); }
  getAllResponseHeaders() { return this._responseHeaders || ""; }
  getResponseHeader(name) {
    const wanted = String(name).toLowerCase();
    const match = (this._responseHeaders || "").split(/\r?\n/).find((line) =>
      line.slice(0, line.indexOf(":")).trim().toLowerCase() === wanted);
    return match ? match.slice(match.indexOf(":") + 1).trim() : null;
  }
  async send(body) {
    const reply = await record("xhr", this._method, this._url, body, this._headers);
    this.status = reply.status || 0;
    this.responseURL = reply.url || new URL(this._url, window.location.href).href;
    this._responseHeaders = Object.entries(reply.headers || {})
      .map(([name, value]) => `${name}: ${value}`).join("\r\n");
    if (this.responseType === "arraybuffer") {
      this.response = bodyBytes(reply).buffer;
    } else if (this.responseType === "json") {
      try { this.response = JSON.parse(reply.body || ""); } catch (_) { this.response = null; }
    } else {
      this.response = reply.body || "";
      this.responseText = reply.body || "";
    }
    this.readyState = 4;
    for (const name of ["readystatechange", "load", "loadend"]) {
      const event = new window.Event(name);
      if (typeof this[`on${name}`] === "function") this[`on${name}`].call(this, event);
      this.dispatchEvent(event);
    }
  }
  abort() {}
}
defineValue(window, "XMLHttpRequest", RuntimeXHR);

defineValue(window, "fetch", async (url, options = {}) => {
  const reply = await record(
    "fetch", options.method || "GET", url, options.body, options.headers || {},
  );
  const bytes = bodyBytes(reply);
  const text = reply.bodyBase64 ? new TextDecoder().decode(bytes) : reply.body || "";
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status || 0,
    url: reply.url || new URL(String(url), window.location.href).href,
    headers: new window.Headers(reply.headers || {}),
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => bytes.buffer,
    blob: async () => new window.Blob([bytes]),
  };
});

window.addEventListener("error", (event) => {
  errors.push(event.error && event.error.stack || event.message || "window error");
});
process.on("uncaughtException", (error) => errors.push(error.stack || String(error)));
process.on("unhandledRejection", (error) => errors.push(error.stack || String(error)));

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const reply = JSON.parse(line);
    const resolve = pending.get(reply.id);
    if (!resolve) return;
    pending.delete(reply.id);
    resolve(reply);
  } catch (error) {
    errors.push(error.stack || String(error));
  }
});

const inlineScripts = Array.from(document.querySelectorAll("script:not([src])"));
for (const [index, script] of inlineScripts.entries()) {
  defineValue(document, "currentScript", script);
  let source = script.textContent || "";
  const reporter = "D[JM(654)]=function(J,G,S,m,U,Uf,Gj,H,ji,jt,jN,jy,jx,jv){";
  if (source.includes(reporter)) {
    source = source.replace(
      reporter,
      reporter + "window.__cfReportedErrors.push({error:String(J&&J.stack||J),G:G,S:S,m:m});",
    );
  }
  defineValue(window, "__cfReportedErrors", reportedErrors);
  evaluate(source, `${input.url}#inline-${index + 1}`);
}
setTimeout(() => {
  for (const data of input.parentMessages || []) {
    window.postMessage(data, window.location.origin);
  }
}, 25);

function finish() {
  if (finished) return;
  finished = true;
  const result = {
    requests,
    parentMessages,
    reportedErrors,
    errors,
    location: window.location.href,
  };
  process.stdout.write(`${JSON.stringify({ type: "final", result })}\n`, () => {
    outer.window.close();
    process.exit(0);
  });
}
setTimeout(finish, input.waitMs || 10_000);
