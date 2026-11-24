/**
 * Side panel bridge.
 *
 * The panel sends the readable text of the active tab to the VaultBrief app in
 * the iframe. All AI work happens inside the app origin, so Firebase AI Logic
 * and App Check see one ordinary https origin; the extension never holds a key.
 *
 * Two failure modes this file guards against:
 *   - posting into an iframe that has not finished loading (the message is
 *     dropped silently), so documents are queued until the load event;
 *   - a host that blocks framing (X-Frame-Options / frame-ancestors), which is
 *     reported with a link to open the app in its own tab instead.
 */

const DEFAULT_APP_URL = "http://localhost:5173/";
const MAX_CHARS = 20000;
const LOAD_TIMEOUT_MS = 8000;

const appFrame = document.getElementById("app");
const appUrlInput = document.getElementById("appUrl");
const grabButton = document.getElementById("grab");
const openButton = document.getElementById("open");
const statusEl = document.getElementById("status");
const frameNote = document.getElementById("frameNote");

let appLoaded = false;
let pending = null;
let loadTimer = null;

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

function send(payload) {
  if (!appLoaded) {
    pending = payload;
    setStatus("waiting for the app to load…");
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
  appLoaded = false;
  pending = null;
  grabButton.disabled = true;
  frameNote.style.display = "none";
  setStatus("loading the app…");
  appFrame.src = url.href;
  clearTimeout(loadTimer);
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
  grabButton.disabled = false;
  frameNote.style.display = "none";
  setStatus("ready");
  if (pending) {
    const payload = pending;
    pending = null;
    send(payload);
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
    grabButton.disabled = !appLoaded;
  }
});

chrome.storage.local.get({ appUrl: DEFAULT_APP_URL }, (values) => {
  appUrlInput.value = values.appUrl;
  applyUrl(values.appUrl);
});
