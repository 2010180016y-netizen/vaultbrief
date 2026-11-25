/**
 * Side panel bridge.
 *
 * The panel sends the readable text of the active tab to the VaultBrief app in
 * the iframe. All AI work happens inside the app origin, so Firebase AI Logic
 * and App Check see one ordinary https origin; the extension never holds a key.
 *
 * The handshake is deliberate, not decorative:
 *   hello   → the iframe is loaded; ask it to identify itself
 *   ready   ← protocol and version; the grab button unlocks only on a match
 *   receipt ← after a brief: route, characters sent, and the receipt seal
 *
 * And the failure modes this file guards against:
 *   - posting into an iframe that has not finished loading (documents are
 *     queued until the ready message, not merely until the load event);
 *   - a host that blocks framing (X-Frame-Options / frame-ancestors), reported
 *     with a link to open the app in its own tab instead;
 *   - a page inside the panel pretending to be the app: messages are accepted
 *     only from the iframe's own window and origin.
 */

const DEFAULT_APP_URL = "http://localhost:5173/";
const PROTOCOL = 2;
const MAX_CHARS = 20000;
const LOAD_TIMEOUT_MS = 8000;
const READY_TIMEOUT_MS = 6000;

const appFrame = document.getElementById("app");
const appUrlInput = document.getElementById("appUrl");
const grabButton = document.getElementById("grab");
const openButton = document.getElementById("open");
const statusEl = document.getElementById("status");
const frameNote = document.getElementById("frameNote");
const receiptEl = document.getElementById("receipt");
const copyButton = document.getElementById("copyReceipt");

let appLoaded = false;
let appReady = false;
let pending = null;
let loadTimer = null;
let readyTimer = null;
let lastReceiptLine = "";

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
}

function appOrigin() {
  try {
    return new URL(appFrame.src).origin;
  } catch {
    return null;
  }
}

function appWindow() {
  return appFrame.contentWindow;
}

function updateGrab() {
  grabButton.disabled = !(appLoaded && appReady);
}

function send(payload) {
  if (!appLoaded || !appReady) {
    pending = payload;
    setStatus("waiting for the app to be ready…");
    return;
  }
  const origin = appOrigin();
  if (!origin) {
    setStatus("set an App URL first", true);
    return;
  }
  appFrame.contentWindow?.postMessage(payload, origin);
  setStatus(`${payload.text.length.toLocaleString()} characters handed to the app`);
}

function hello() {
  const origin = appOrigin();
  if (!origin) return;
  appFrame.contentWindow?.postMessage({ type: "vaultbrief:hello", protocol: PROTOCOL }, origin);
}

function showReceipt(receipt) {
  const route = receipt.source === "on_device" ? "on-device" : "cloud";
  const sent =
    receipt.cloudChars === 0
      ? "0 characters sent"
      : `${receipt.cloudChars.toLocaleString()} of ${receipt.inputChars.toLocaleString()} characters sent`;
  const flags = [receipt.redacted ? "masked" : null, receipt.simulated ? "simulated" : null].filter(Boolean);
  const seal = receipt.digest
    ? `sealed ${receipt.signed ? "signed" : "digest"} ${receipt.digest.slice(0, 12)}…`
    : "unsealed";
  lastReceiptLine = `${route} · ${sent}${flags.length ? ` · ${flags.join(" · ")}` : ""} · ${seal}`;
  receiptEl.textContent = lastReceiptLine;
  receiptEl.classList.add("on");
  copyButton.hidden = false;
}

/** Runs in the page: pulls the visible text, skipping chrome and navigation. */
function extractPageText() {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "HEADER", "FOOTER", "ASIDE", "FORM"]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      return skip.has(node.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts = [];
  let node = walker.currentNode;
  for (; node; node = walker.nextNode()) {
    if (node.tagName === "P" || node.tagName === "LI" || node.tagName === "H1" || node.tagName === "H2" || node.tagName === "H3") {
      const text = (node.innerText || "").trim();
      if (text.length > 40) parts.push(text);
    }
  }
  if (parts.length === 0) parts.push(document.body.innerText || "");
  return {
    title: document.title,
    text: parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function resetBridge() {
  appLoaded = false;
  appReady = false;
  pending = null;
  updateGrab();
  clearTimeout(loadTimer);
  clearTimeout(readyTimer);
  receiptEl.classList.remove("on");
  receiptEl.textContent = "";
  copyButton.hidden = true;
}

function applyUrl(value) {
  const candidate = (value || "").trim() || DEFAULT_APP_URL;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    setStatus("that is not a valid URL", true);
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    setStatus("the app URL must be http(s)", true);
    return;
  }
  resetBridge();
  frameNote.style.display = "none";
  setStatus("loading the app…");
  appFrame.src = url.href;
  loadTimer = setTimeout(() => {
    if (!appLoaded) {
      frameNote.style.display = "block";
      setStatus("the app did not load in the panel", true);
    }
  }, LOAD_TIMEOUT_MS);
}

appFrame.addEventListener("load", () => {
  if (!appFrame.src) return;
  appLoaded = true;
  clearTimeout(loadTimer);
  frameNote.style.display = "none";
  setStatus("app loaded · waiting for the handshake…");
  hello();
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (!appReady) {
      setStatus("the app is loaded but did not answer the handshake", true);
    }
  }, READY_TIMEOUT_MS);
});

window.addEventListener("message", (event) => {
  // Only the iframe we loaded, on the origin we loaded it from.
  if (!appLoaded || event.source !== appWindow() || event.origin !== appOrigin()) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "vaultbrief:ready") {
    if (data.protocol !== PROTOCOL) {
      setStatus(`protocol mismatch: panel ${PROTOCOL}, app ${data.protocol} — update one of them`, true);
      appReady = false;
      updateGrab();
      return;
    }
    appReady = true;
    clearTimeout(readyTimer);
    updateGrab();
    setStatus(`ready · app v${data.version}`);
    if (pending) {
      const payload = pending;
      pending = null;
      send(payload);
    }
    return;
  }

  if (data.type === "vaultbrief:receipt" && data.receipt) {
    showReceipt(data.receipt);
    setStatus(`brief ready · ${data.receipt.source === "on_device" ? "on-device" : "cloud"}`);
  }
});

appUrlInput.addEventListener("change", () => {
  const url = appUrlInput.value.trim() || DEFAULT_APP_URL;
  chrome.storage.local.set({ appUrl: url });
  applyUrl(url);
});

openButton.addEventListener("click", () => {
  const value = appUrlInput.value.trim() || DEFAULT_APP_URL;
  chrome.tabs.create({ url: value });
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastReceiptLine);
    copyButton.textContent = "copied";
    setTimeout(() => {
      copyButton.textContent = "copy";
    }, 1500);
  } catch {
    copyButton.textContent = "copy failed";
  }
});

grabButton.addEventListener("click", async () => {
  grabButton.disabled = true;
  setStatus("reading the page…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("no active tab");
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageText });
    const page = result?.result;
    if (!page?.text) throw new Error("this page has no readable text");

    send({
      type: "vaultbrief:document",
      text: page.text.slice(0, MAX_CHARS),
      title: page.title,
      url: tab.url || "",
    });
  } catch (error) {
    setStatus(`could not read the page: ${error.message}`, true);
  } finally {
    updateGrab();
  }
});

appFrame.addEventListener("error", () => {
  frameNote.style.display = "block";
});

chrome.storage.local.get({ appUrl: DEFAULT_APP_URL }, (values) => {
  appUrlInput.value = values.appUrl;
  applyUrl(values.appUrl);
});
