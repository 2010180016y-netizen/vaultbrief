// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { BRIDGE_PROTOCOL } from "./engine/bridge";

/**
 * End-to-end UI smoke test in jsdom.
 *
 * The remote judge browser cannot reach this dev server, so the whole screen is
 * exercised here instead: mount, pick a sample, route, run, receipt.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<App />);
    // Let the on-device probe settle inside act().
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

function buttonByExactText(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

async function postFromPanel(data: unknown, origin = "chrome-extension://vaultbriefpanel") {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: window }));
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  }
  return predicate();
}

function setValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

describe("VaultBrief screen", () => {
  it("boots in demo mode and explains why", async () => {
    const el = await mount();
    expect(el.textContent).toContain("VaultBrief");
    expect(el.textContent).toContain("Demo mode");
    expect(el.textContent).toContain("Press “Brief this document” to try it.");
    expect(el.textContent).toContain("Sensitivity scan");
    expect(el.textContent).toContain("Routing decision");
  });

  it("previews a device-only route for the private sample", async () => {
    const el = await mount();
    expect(el.textContent).toContain("Sensitive document");
    expect(buttonByText("Hospital discharge summary").className).toContain("active");
  });

  it("switches to a cloud route for the public long sample", async () => {
    const el = await mount();
    await click(buttonByText("Public policy newsletter"));
    // Public (14/100) → cloud, but the footer address is masked first.
    expect(el.textContent).toContain("cloud model, after 1 identifier is masked");
  });

  it("runs a brief and shows a privacy receipt", async () => {
    const el = await mount();
    await click(buttonByText("Brief this document"));
    expect(await waitFor(() => el.textContent!.includes("Privacy receipt"), 12000)).toBe(true);
    expect(el.textContent).toContain("Stayed local");
    expect(el.textContent).toContain("simulated");
    expect(el.textContent).toContain("gemini-3.5-flash-lite");
    // Ledger picked the run up (jsdom has no Nano, so this is the masked cloud path).
    expect(el.textContent).toContain("masked");
    // A simulated run is never turned into a dollar figure.
    expect(el.textContent).toContain("simulated runs are not billed");
  }, 20000);

  it("blocks a private document when masking is off and demo has no device", async () => {
    const el = await mount();
    // In jsdom there is no Prompt API, so the private sample falls back to the
    // masked-cloud route; turning masking off must refuse the run instead.
    const toggle = [...el.querySelectorAll("button")].find((b) => b.className.includes("switch"))!;
    await click(toggle);
    expect(el.textContent).toContain("will not send");
    await click(buttonByText("Brief this document"));
    expect(await waitFor(() => el.textContent!.includes("not sent anywhere"), 6000)).toBe(true);
  }, 15000);

  it("warns that App Check is required before leaving demo mode", async () => {
    const el = await mount();
    await click(buttonByText("Connect Firebase"));
    await click(buttonByText("Save & reload"));
    expect(el.textContent).toContain("Paste a Firebase web app config first");

    const configArea = el.querySelector(".drawer textarea") as HTMLTextAreaElement;
    await act(async () => {
      setValue(configArea, JSON.stringify({ apiKey: "AIzaSyFAKE", projectId: "review-project" }));
    });
    await click(buttonByText("Save & reload"));
    expect(el.textContent).toContain("App Check is required for Firebase AI Logic");
  });

  it("answers the extension handshake and takes the page it sends", async () => {
    const el = await mount();
    const posted = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    try {
      await postFromPanel({ type: "vaultbrief:hello", protocol: BRIDGE_PROTOCOL });
      expect(posted).toHaveBeenCalled();
      const [ready, origin] = posted.mock.calls[0] as unknown as [
        { type: string; protocol: number },
        string,
      ];
      expect(ready.type).toBe("vaultbrief:ready");
      expect(ready.protocol).toBe(BRIDGE_PROTOCOL);
      // Replies go to the frame that spoke, never to "*".
      expect(origin).toBe("chrome-extension://vaultbriefpanel");

      await postFromPanel({
        type: "vaultbrief:document",
        text: "Patient: Daniel Okafor. Diagnosis: stable angina. Phone +1 415 555 0134.",
        title: "Clinic note",
      });
      const area = el.querySelector("textarea.doc-input") as HTMLTextAreaElement;
      expect(area.value).toContain("stable angina");
      expect(el.textContent).toContain("Clinic note");
    } finally {
      posted.mockRestore();
    }
  });

  it("ignores a document from an origin that is not the panel", async () => {
    const el = await mount();
    const before = (el.querySelector("textarea.doc-input") as HTMLTextAreaElement).value;
    await postFromPanel({ type: "vaultbrief:document", text: "Injected by another page." }, "https://evil.example");
    expect((el.querySelector("textarea.doc-input") as HTMLTextAreaElement).value).toBe(before);
  });

  it("verifies the receipt it just issued, including the document binding", async () => {
    const el = await mount();
    await click(buttonByText("Brief this document"));
    expect(await waitFor(() => el.textContent!.includes("Privacy receipt"), 12000)).toBe(true);
    expect(el.textContent).toContain("sealed");

    await click(buttonByText("Verify receipt"));
    await click(buttonByExactText("Verify"));
    expect(await waitFor(() => el.textContent!.includes("Verified"), 8000)).toBe(true);
    expect(el.textContent).toContain("document fingerprint");
    expect(el.textContent).toContain("signature");
  }, 25000);
});
