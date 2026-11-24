/**
 * Side panel bridge.
 *
 * The panel sends the readable text of the active tab to the VaultBrief app in
 * the iframe. All AI work happens inside the app origin, so Firebase AI Logic
 * and App Check see one ordinary https origin; the extension never holds a key.
 */

const DEFAULT_APP_URL = "http://localhost:5173/";
const MAX_CHARS = 20000;

const appFrame = document.getElementById("app");
const appUrlInput = document.getElementById("appUrl");
const grabButton = document.getElementById("grab");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
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

function loadAppUrl() {
  chrome.storage.local.get({ appUrl: DEFAULT_APP_URL }, (values) => {
    appUrlInput.value = values.appUrl;
    appFrame.src = values.appUrl;
  });
}

appUrlInput.addEventListener("change", () => {
  const url = appUrlInput.value.trim() || DEFAULT_APP_URL;
  chrome.storage.local.set({ appUrl: url });
  appFrame.src = url;
});

grabButton.addEventListener("click", async () => {
  grabButton.disabled = true;
  setStatus("reading the page…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active tab");
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageText });
    const page = result?.result;
    if (!page?.text) throw new Error("this page has no readable text");

    const text = page.text.slice(0, MAX_CHARS);
    appFrame.contentWindow?.postMessage(
      { type: "vaultbrief:document", text, title: page.title },
      new URL(appFrame.src).origin,
    );
    setStatus(`${text.length.toLocaleString()} characters handed to the app`);
  } catch (error) {
    setStatus(`could not read the page: ${error.message}`);
  } finally {
    grabButton.disabled = false;
  }
});

loadAppUrl();
