// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

/**
 * End-to-end UI smoke test in jsdom.
 *
 * The remote judge browser cannot reach this dev server, so the whole screen is
 * exercised here instead: mount, pick a sample, route, run, receipt.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<App />);
  });
  return container;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

describe("VaultBrief screen", () => {
  it("boots in demo mode and explains why", () => {
    const el = mount();
    expect(el.textContent).toContain("VaultBrief");
    expect(el.textContent).toContain("Demo mode");
    expect(el.textContent).toContain("Sensitivity scan");
    expect(el.textContent).toContain("Routing decision");
  });

  it("previews a device-only route for the private sample", () => {
    const el = mount();
    expect(el.textContent).toContain("Sensitive document");
    expect(buttonByText("Hospital discharge summary").className).toContain("active");
  });

  it("switches to a cloud route for the public long sample", async () => {
    const el = mount();
    await act(async () => {
      buttonByText("Public policy newsletter").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("cloud model for long-form synthesis");
  });

  it("runs a brief and shows a privacy receipt", async () => {
    const el = mount();
    await act(async () => {
      buttonByText("Brief this document").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(await waitFor(() => el.textContent!.includes("Privacy receipt"), 12000)).toBe(true);
    expect(el.textContent).toContain("Stayed local");
    expect(el.textContent).toContain("simulated");
    // Ledger picked the run up (jsdom has no Nano, so this is the masked cloud path).
    expect(el.textContent).toContain("masked");
  }, 20000);

  it("blocks a private document when masking is off and demo has no device", async () => {
    const el = mount();
    // In jsdom there is no Prompt API, so the private sample falls back to the
    // masked-cloud route; turning masking off must refuse the run instead.
    const toggle = [...el.querySelectorAll("button")].find((b) => b.className.includes("switch"))!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("will not send");
    await act(async () => {
      buttonByText("Brief this document").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(await waitFor(() => el.textContent!.includes("not sent anywhere"), 6000)).toBe(true);
  }, 15000);
});
