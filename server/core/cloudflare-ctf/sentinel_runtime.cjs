const fs = require("fs");
const readline = require("readline");
const vm = require("vm");
const { JSDOM, VirtualConsole } = require("jsdom");
const nodeCrypto = require("crypto");

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const errors = [];
const requests = [];
const pending = new Map();
const contexts = new Set();
const vmContexts = new WeakMap();
let requestId = 0;
let frameWindow = null;
let frameElement = null;
let frameProxy = null;
let sdkLoaded = false;
let frameLoadPending = false;

function debug(message) {
  if (!input.debug) return;
  process.stderr.write(`[sentinel] ${message}\n`);
}

function defineValue(target, name, value) {
  try {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
  } catch (_) {}
}

function headerObject(headers) {
  if (!headers) return {};
  if (typeof headers === "object" && !Array.isArray(headers)) {
    if (typeof headers.entries === "function") {
      return Object.fromEntries(headers.entries());
    }
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
      String(key), String(value),
    ]));
  }
  return {};
}

function reportError(error) {
  errors.push(error && error.stack || String(error));
}

function makeVirtualConsole() {
  const console = new VirtualConsole();
  console.on("jsdomError", reportError);
  return console;
}

function record(win, kind, method, url, body, headers) {
  const item = {
    id: ++requestId,
    kind,
    method: String(method || "GET").toUpperCase(),
    url: new URL(String(url), win.location.href).href,
    sourceUrl: win.location.href,
    sourceOrigin: win.location.origin,
    body: body == null ? "" : String(body),
    headers: headerObject(headers),
    at: Math.round(win.performance.now()),
  };
  requests.push(item);
  process.stdout.write(`${JSON.stringify({ type: "request", request: item })}\n`);
  return new Promise((resolve) => pending.set(item.id, resolve));
}

function responseFor(win, reply, requestUrl) {
  const body = reply.body || "";
  const headers = new win.Headers(reply.headers || {});
  return {
    ok: Number(reply.status || 0) >= 200 && Number(reply.status || 0) < 300,
    status: Number(reply.status || 0),
    statusText: "",
    url: reply.url || requestUrl,
    headers,
    redirected: false,
    type: "basic",
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    clone: function clone() { return responseFor(win, reply, requestUrl); },
  };
}

function installFetch(win) {
  defineValue(win, "fetch", async (url, options = {}) => {
    const reply = await record(
      win,
      "fetch",
      options.method || "GET",
      url,
      options.body,
      options.headers || {},
    );
    return responseFor(win, reply, new URL(String(url), win.location.href).href);
  });
}

class RuntimeXHR extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.response = "";
    this.responseText = "";
    this.responseType = "";
    this.responseURL = "";
    this.timeout = 0;
    this._headers = {};
    this._method = "GET";
    this._url = "";
    this._responseHeaders = "";
  }

  open(method, url) {
    this._method = String(method || "GET");
    this._url = String(url);
    this.readyState = 1;
    this.dispatchEvent(new Event("readystatechange"));
  }

  setRequestHeader(name, value) {
    this._headers[String(name)] = String(value);
  }

  getAllResponseHeaders() {
    return this._responseHeaders;
  }

  getResponseHeader(name) {
    const wanted = String(name).toLowerCase();
    const line = this._responseHeaders.split(/\r?\n/).find((value) => {
      const colon = value.indexOf(":");
      return colon >= 0 && value.slice(0, colon).trim().toLowerCase() === wanted;
    });
    return line ? line.slice(line.indexOf(":") + 1).trim() : null;
  }

  async send(body) {
    const reply = await record(this._window, "xhr", this._method, this._url, body, this._headers);
    this.status = Number(reply.status || 0);
    this.statusText = "";
    this.responseURL = reply.url || new URL(this._url, this._window.location.href).href;
    this._responseHeaders = Object.entries(reply.headers || {})
      .map(([name, value]) => `${name}: ${value}`).join("\r\n");
    const responseBody = reply.body || "";
    if (this.responseType === "json") {
      try { this.response = JSON.parse(responseBody); } catch (_) { this.response = null; }
    } else if (this.responseType === "arraybuffer") {
      this.response = new TextEncoder().encode(responseBody).buffer;
    } else {
      this.response = responseBody;
      this.responseText = responseBody;
    }
    this.readyState = 4;
    for (const eventName of ["readystatechange", "load", "loadend"]) {
      const event = new this._window.Event(eventName);
      const handler = this[`on${eventName}`];
      if (typeof handler === "function") handler.call(this, event);
      this.dispatchEvent(event);
    }
  }

  abort() {}
}

function installXHR(win) {
  defineValue(win, "XMLHttpRequest", class extends RuntimeXHR {
    constructor() {
      super();
      this._window = win;
    }
  });
}

function installEnvironment(win, isFrame) {
  defineValue(win.navigator, "userAgent", input.userAgent);
  defineValue(win.navigator, "appVersion", input.userAgent.replace(/^Mozilla\//, ""));
  defineValue(win.navigator, "platform", input.platform || "MacIntel");
  defineValue(win.navigator, "language", input.language || "zh-CN");
  defineValue(win.navigator, "languages", input.languages || ["zh-CN", "zh"]);
  defineValue(win.navigator, "hardwareConcurrency", input.hardwareConcurrency || 8);
  defineValue(win.navigator, "deviceMemory", input.deviceMemory || 8);
  defineValue(win.navigator, "webdriver", undefined);
  defineValue(win.screen, "width", input.screenWidth || 1920);
  defineValue(win.screen, "height", input.screenHeight || 1080);
  defineValue(win.screen, "availWidth", input.screenWidth || 1920);
  defineValue(win.screen, "availHeight", input.screenHeight || 1080);

  if (!win.crypto.randomUUID) {
    defineValue(win.crypto, "randomUUID", () => nodeCrypto.randomUUID());
  }
  if (!win.performance.memory) {
    defineValue(win.performance, "memory", {
      jsHeapSizeLimit: input.jsHeapSizeLimit || 4395630592,
      totalJSHeapSize: input.totalJSHeapSize || 0,
      usedJSHeapSize: input.usedJSHeapSize || 0,
    });
  }
  defineValue(win, "requestIdleCallback", (callback) => setTimeout(() => callback({
    didTimeout: false,
    timeRemaining: () => 1,
  }), 0));
  defineValue(win, "cancelIdleCallback", (id) => clearTimeout(id));
  defineValue(win, "__sentinelFrame", Boolean(isFrame));
  installFetch(win);
  installXHR(win);
  contexts.add(win);
}

function dispatchMessage(target, data, source, origin) {
  try {
    const event = new target.MessageEvent("message", {
      data,
      origin,
      source,
    });
    target.dispatchEvent(event);
  } catch (error) {
    reportError(error);
  }
}

function installFrameBridge(parentWindow, childWindow) {
  const parentOrigin = parentWindow.location.origin;
  const childOrigin = childWindow.location.origin;
  const parentProxy = {
    postMessage(data, targetOrigin) {
      dispatchMessage(parentWindow, data, childWindow, childOrigin);
    },
  };
  frameProxy = parentProxy;
  defineValue(childWindow, "parent", parentProxy);
  defineValue(childWindow, "top", parentWindow);
  defineValue(childWindow, "frameElement", {});
  defineValue(childWindow, "postMessage", (data, targetOrigin) => {
    dispatchMessage(parentWindow, data, childWindow, childOrigin);
  });
}

function evaluate(win, source, filename, currentScript) {
  try {
    if (currentScript) defineValue(win.document, "currentScript", currentScript);
    const context = vmContexts.get(win);
    if (context) {
      new vm.Script(source, { filename }).runInContext(context);
    } else {
      win.eval(source);
    }
  } catch (error) {
    reportError(error);
  }
}

function createFrame(parentWindow, node) {
  if (frameWindow) return frameWindow;
  const frameUrl = node.src || node.getAttribute("src") || input.frameUrl;
  const childWindow = node.contentWindow;
  if (!childWindow) throw new Error("Sentinel iframe has no contentWindow");
  installEnvironment(childWindow, true);
  installFrameBridge(parentWindow, childWindow);
  frameWindow = childWindow;
  frameElement = node;
  debug(`frame created: ${frameUrl}`);
  process.stdout.write(`${JSON.stringify({ type: "frame", url: frameUrl })}\n`);

  const script = childWindow.document.createElement("script");
  script.src = input.sdkUrl;
  debug("frame script element");
  // Do not attach an external script node: jsdom may try to navigate the
  // iframe before the local source is evaluated.
  evaluate(childWindow, input.sdkSource, input.sdkUrl, script);
  debug("frame source evaluated");
  debug(`frame sdk=${Boolean(childWindow.SentinelSDK)} topDiff=${childWindow.top !== childWindow} evalTopDiff=${childWindow.eval("window.top !== window")} parentPost=${typeof childWindow.parent?.postMessage}`);
  childWindow.addEventListener("message", (event) => debug(`frame received message: ${event.data && event.data.type} sourceParent=${event.source === childWindow.parent} origin=${event.origin}`), true);
  defineValue(childWindow, "postMessage", (data, targetOrigin) => {
    debug(`parent to frame message: ${data && data.type}`);
    dispatchMessage(childWindow, data, childWindow.parent, parentWindow.location.origin);
  });
  frameLoadPending = true;
  return childWindow;
}

function dispatchFrameLoad() {
  if (!frameWindow || !frameLoadPending) return;
  frameLoadPending = false;
  debug("dispatch frame load");
  frameElement?.dispatchEvent(new parentWindow.Event("load"));
  frameWindow.dispatchEvent(new frameWindow.Event("load"));
}

function inspectInsertedNode(win, node) {
  if (!node || typeof node !== "object") return;
  const name = String(node.localName || "").toLowerCase();
  if (name === "iframe" && !frameWindow) {
    const src = node.src || node.getAttribute("src") || "";
    if (src.includes("/backend-api/sentinel/frame.html")) createFrame(win, node);
  }
  if (name === "script" && node.src && node.src === input.sdkUrl && win === parentWindow) {
    evaluate(win, input.sdkSource, input.sdkUrl, node);
    setTimeout(() => node.dispatchEvent(new win.Event("load")), 0);
  }
}

const parentDom = new JSDOM(
  input.html || "<!doctype html><html><head></head><body></body></html>",
  {
    url: input.url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: makeVirtualConsole(),
  },
);
const parentWindow = parentDom.window;
vmContexts.set(parentWindow, parentDom.getInternalVMContext());
installEnvironment(parentWindow, false);
for (const [name, value] of Object.entries(input.cookies || {})) {
  parentWindow.document.cookie = `${name}=${value}; Domain=.openai.com; Path=/`;
}
debug(`cookies=${parentWindow.document.cookie.replace(/=.*/g, "=<present>")}`);

const nativeAppendChild = parentWindow.Node.prototype.appendChild;
parentWindow.Node.prototype.appendChild = function appendChild(node) {
  const result = nativeAppendChild.call(this, node);
  inspectInsertedNode(parentWindow, node);
  return result;
};

parentWindow.addEventListener("error", (event) => reportError(event.error || event.message));
process.on("uncaughtException", reportError);
process.on("unhandledRejection", reportError);

function loadSdk() {
  debug("loading loader");
  const loader = parentWindow.document.createElement("script");
  loader.src = input.loaderUrl;
  parentWindow.document.head.appendChild(loader);
  evaluate(parentWindow, input.loaderSource, input.loaderUrl, loader);
  sdkLoaded = true;
  debug(`loader evaluated, sdk=${Boolean(parentWindow.SentinelSDK)}`);
}

function waitForSdk(deadline = Date.now() + 15_000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (parentWindow.SentinelSDK && typeof parentWindow.SentinelSDK.token === "function") {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error("SentinelSDK did not initialize"));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

async function callSdk(method, flow) {
  debug(`call ${method} ${flow}`);
  await waitForSdk();
  debug(`sdk ready ${typeof parentWindow.SentinelSDK[method]}`);
  if (typeof parentWindow.SentinelSDK[method] !== "function") {
    throw new Error(`SentinelSDK.${method} is unavailable`);
  }
  const promise = parentWindow.SentinelSDK[method](flow);
  setTimeout(dispatchFrameLoad, 0);
  const value = await promise;
  debug(`call completed ${method}`);
  return value == null ? null : String(value);
}

function sendResult(value, method, flow) {
  process.stdout.write(`${JSON.stringify({
    type: "result",
    method,
    flow,
    value,
    errors: errors.slice(),
    requests: requests.length,
    requestSummaries: requests.map((request) => ({
      kind: request.kind,
      method: request.method,
      url: request.url,
      sourceUrl: request.sourceUrl,
      bodyLength: request.body.length,
    })),
    frameCreated: Boolean(frameWindow),
    environment: {
      screenWidth: parentWindow.screen?.width ?? null,
      screenHeight: parentWindow.screen?.height ?? null,
      userAgent: parentWindow.navigator?.userAgent ?? null,
      platform: parentWindow.navigator?.platform ?? null,
      language: parentWindow.navigator?.language ?? null,
      languages: parentWindow.navigator?.languages ?? null,
      hardwareConcurrency: parentWindow.navigator?.hardwareConcurrency ?? null,
      deviceMemory: parentWindow.navigator?.deviceMemory ?? null,
      hasPerformanceMemory: Boolean(parentWindow.performance?.memory),
      cookieNames: String(parentWindow.document.cookie || "")
        .split(/;\s*/).filter(Boolean).map((item) => item.split("=", 1)[0]),
    },
  })}\n`);
}

loadSdk();

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    reportError(error);
    return;
  }
  if (command.type === "shutdown") {
    parentDom.window.close();
    if (frameWindow) frameWindow.close();
    process.exit(0);
  }
  if (command.type === "call") {
    callSdk(String(command.method || "token"), String(command.flow || "default"))
      .then((value) => sendResult(value, command.method, command.flow))
      .catch((error) => sendResult(null, command.method, command.flow) || reportError(error));
    return;
  }
  const resolve = pending.get(command.id);
  if (!resolve) return;
  pending.delete(command.id);
  resolve(command);
});
