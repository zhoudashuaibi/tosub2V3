const fs = require("fs");
const readline = require("readline");
const vm = require("vm");
const { JSDOM, VirtualConsole } = require("jsdom");

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dom = new JSDOM(input.html, {
  url: input.url,
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
const { window } = dom;
const context = dom.getInternalVMContext();
const errors = [];
const requests = [];
const frames = [];
const frameMessages = [];
const pending = new Map();
const loadingScripts = new WeakSet();
let requestId = 0;
let finished = false;
let activeFrameWindow = null;
defineValue(window, "__cfFlow", []);

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
  window.__cfFlow.push({
    messageEvent: true,
    trusted: event.isTrusted,
    originBefore: event.origin,
    sourceMatchesBefore: event.source === activeFrameWindow,
    widgetId: event.data && event.data.widgetId,
    eventName: event.data && event.data.event,
  });
  if (!activeFrameWindow || !event.isTrusted) return;
  if (event.source !== activeFrameWindow) defineValue(event, "source", activeFrameWindow);
  if (!event.origin) defineValue(event, "origin", "https://challenges.cloudflare.com");
  window.__cfFlow.push({
    messagePatched: true,
    originAfter: event.origin,
    sourceMatchesAfter: event.source === activeFrameWindow,
  });
}, true);
defineValue(window, "__cfPerformanceEntries", input.performanceEntries || []);
new vm.Script(`(() => {
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
  const performancePrototype = Object.getPrototypeOf(window.performance);
  Object.defineProperty(performancePrototype, "getEntries", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function getEntries() { return entries.slice(); },
  });
  Object.defineProperty(performancePrototype, "getEntriesByType", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function getEntriesByType(type) {
      return entries.filter((entry) => entry.entryType === String(type));
    },
  });
  Object.defineProperty(performancePrototype, "getEntriesByName", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function getEntriesByName(name, type) {
      return entries.filter((entry) => entry.name === String(name) &&
        (type === undefined || entry.entryType === String(type)));
    },
  });
  class PerformanceObserver {
    constructor(callback) {
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      this._callback = callback;
      this._records = [];
    }
    observe(options) { this._options = options; }
    disconnect() { this._records.length = 0; }
    takeRecords() { return this._records.splice(0); }
  }
  Object.defineProperty(PerformanceObserver, "supportedEntryTypes", {
    configurable: true,
    get: function supportedEntryTypes() {
      return ["element", "event", "first-input", "largest-contentful-paint",
        "layout-shift", "long-animation-frame", "longtask", "mark", "measure",
        "navigation", "paint", "resource", "visibility-state"];
    },
  });
  window.PerformanceObserver = PerformanceObserver;
})()` , { filename: "performance-bootstrap.js" }).runInContext(context);
new vm.Script(`(() => {
  const objectUrls = new Set();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: function createObjectURL(blob) {
      if (!(blob instanceof Blob)) throw new TypeError("Overload resolution failed");
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
      const url = "blob:" + location.origin + "/" + token;
      objectUrls.add(url);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: function revokeObjectURL(url) { objectUrls.delete(String(url)); },
  });
  class Worker extends EventTarget {
    constructor(url, options = {}) {
      super();
      this._url = String(url);
      this._options = options;
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
    }
    postMessage() {}
    terminate() {}
  }
  window.Worker = Worker;
})()` , { filename: "worker-bootstrap.js" }).runInContext(context);
new vm.Script(`(() => {
  class ReadableStream {
    constructor(underlyingSource = {}, strategy = {}) {
      this.locked = false;
      this._source = underlyingSource;
      this._strategy = strategy;
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
})()` , { filename: "streams-bootstrap.js" }).runInContext(context);

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

class RuntimeXHR extends window.EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.status = 0;
    this.response = "";
    this.responseText = "";
    this.responseType = "";
    this.responseURL = "";
    this._headers = {};
    this._method = "GET";
    this._url = "";
  }

  open(method, url) {
    this._method = method;
    this._url = url;
    this.readyState = 1;
    this.dispatchEvent(new window.Event("readystatechange"));
  }

  setRequestHeader(name, value) {
    this._headers[String(name)] = String(value);
  }

  getAllResponseHeaders() {
    return this._responseHeaders || "";
  }

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
    const responseBody = reply.body || "";
    if (this.responseType === "arraybuffer") {
      this.response = new TextEncoder().encode(responseBody).buffer;
    } else if (this.responseType === "json") {
      try {
        this.response = JSON.parse(responseBody);
      } catch (_) {
        this.response = null;
      }
    } else {
      this.response = responseBody;
      this.responseText = responseBody;
    }
    this.readyState = 4;
    for (const eventName of ["readystatechange", "load", "loadend"]) {
      const event = new window.Event(eventName);
      const handler = this[`on${eventName}`];
      if (typeof handler === "function") handler.call(this, event);
      this.dispatchEvent(event);
    }
  }

  abort() {}
}

defineValue(window, "XMLHttpRequest", RuntimeXHR);
defineValue(window, "fetch", async (url, options = {}) => {
  const reply = await record(
    "fetch",
    options.method || "GET",
    url,
    options.body,
    options.headers || {},
  );
  const body = reply.body || "";
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status || 0,
    url: reply.url || new URL(String(url), window.location.href).href,
    headers: new window.Headers(reply.headers || {}),
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
});

const nativeAppendChild = window.Node.prototype.appendChild;
window.Node.prototype.appendChild = function appendChild(node) {
  const result = nativeAppendChild.call(this, node);
  inspectInsertedNode(node);
  return result;
};

function inspectInsertedNode(node) {
  if (!node || typeof node !== "object") return;
  const name = String(node.localName || "").toLowerCase();
  if (name === "script" && node.src && !loadingScripts.has(node)) {
    loadingScripts.add(node);
    record("script", "GET", node.src, "", {}).then((reply) => {
      if ((reply.status || 0) >= 200 && (reply.status || 0) < 300) {
        const resource = {
          name: reply.url || node.src,
          entryType: "resource",
          initiatorType: "script",
          nextHopProtocol: "h2",
          startTime: Math.max(0, window.performance.now() - 20),
          duration: 20,
          requestStart: Math.max(0, window.performance.now() - 18),
          responseStart: Math.max(0, window.performance.now() - 10),
          responseEnd: window.performance.now(),
          transferSize: (reply.body || "").length,
          encodedBodySize: (reply.body || "").length,
          decodedBodySize: (reply.body || "").length,
        };
        const ResourceTiming = window.PerformanceResourceTiming;
        if (ResourceTiming) Object.setPrototypeOf(resource, ResourceTiming.prototype);
        window.__cfPerformanceEntries.push(resource);
        evaluate(reply.body || "", reply.url || node.src, node);
        node.dispatchEvent(new window.Event("load"));
      } else {
        node.dispatchEvent(new window.Event("error"));
      }
    }).catch((error) => errors.push(error.stack || String(error)));
  }
  if (name === "iframe") {
    const src = node.src || node.getAttribute("src") || "";
    if (src && !frames.includes(src)) {
      frames.push(src);
      process.stdout.write(`${JSON.stringify({ type: "frame", url: src })}\n`);
      let childWindow = node.contentWindow;
      if (!childWindow) {
        const bridgeFrame = window.document.createElement("iframe");
        bridgeFrame.setAttribute("aria-hidden", "true");
        bridgeFrame.style.display = "none";
        window.document.body.appendChild(bridgeFrame);
        childWindow = bridgeFrame.contentWindow;
        if (childWindow) defineValue(node, "contentWindow", childWindow);
      }
      if (childWindow) {
        activeFrameWindow = childWindow;
        defineValue(childWindow, "postMessage", function postMessage(data, targetOrigin) {
          const item = { data, targetOrigin: String(targetOrigin || "") };
          frameMessages.push(item);
          process.stdout.write(`${JSON.stringify({ type: "frame-message", message: item })}\n`);
        });
        const match = src.match(/\/rch\/([^/]+)/);
        const widgetId = match ? match[1] : "";
        window.__cfFlow.push({
          frameBridgeInstalled: true,
          parentMatches: childWindow.parent === window,
          parentPostMessageType: typeof childWindow.parent.postMessage,
          widgetId,
        });
        setTimeout(() => {
          window.__cfFlow.push({ frameBridgeTimer: true, widgetId });
          try {
            for (const data of [
              { source: "cloudflare-challenge", widgetId, event: "init", mode: "managed" },
              { source: "cloudflare-challenge", widgetId, event: "requestExtraParams" },
            ]) {
              childWindow.parent.postMessage(data, window.location.origin);
            }
            window.__cfFlow.push({ frameBridgeSent: true, widgetId });
          } catch (error) {
            errors.push(error.stack || String(error));
          }
        }, 25);
      }
    }
  }
  if (typeof node.querySelectorAll === "function") {
    for (const frame of node.querySelectorAll("iframe")) inspectInsertedNode(frame);
  }
}

const observer = new window.MutationObserver((records) => {
  for (const mutation of records) {
    for (const node of mutation.addedNodes) inspectInsertedNode(node);
  }
});
observer.observe(window.document.documentElement, { childList: true, subtree: true });

window.addEventListener("error", (event) => {
  errors.push(event.error && event.error.stack || event.message || "window error");
});
process.on("uncaughtException", (error) => errors.push(error.stack || String(error)));
process.on("unhandledRejection", (error) => errors.push(error.stack || String(error)));

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const reply = JSON.parse(line);
    if (reply.type === "child-message") {
      if (activeFrameWindow) {
        activeFrameWindow.parent.postMessage(reply.data, window.location.origin);
      }
      return;
    }
    const resolve = pending.get(reply.id);
    if (!resolve) return;
    pending.delete(reply.id);
    resolve(reply);
  } catch (error) {
    errors.push(error.stack || String(error));
  }
});

function evaluate(source, filename, currentScript) {
  if (currentScript) defineValue(window.document, "currentScript", currentScript);
  try {
    new vm.Script(source, { filename }).runInContext(context);
  } catch (error) {
    errors.push(error.stack || String(error));
  }
}

for (const [index, source] of (input.inlineScripts || []).entries()) {
  evaluate(source, `${input.url}#inline-${index + 1}`, null);
}

window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
window.dispatchEvent(new window.Event("load"));

function finish() {
  if (finished) return;
  finished = true;
  const result = {
    requests,
    frames,
    frameMessages,
    errors,
    location: window.location.href,
    globals: Object.getOwnPropertyNames(window).filter((name) => /cf|chl|turn/i.test(name)),
    probe: window.__cfProbe || null,
    flow: window.__cfFlow || [],
  };
  process.stdout.write(`${JSON.stringify({ type: "final", result })}\n`, () => {
    window.close();
    process.exit(0);
  });
}

setTimeout(finish, input.waitMs || 10_000);
