// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isDeviceReady, probeDevice } from "./device";

type Globals = { LanguageModel?: unknown; ai?: unknown };
const scope = globalThis as unknown as Globals;

afterEach(() => {
  delete scope.LanguageModel;
  delete scope.ai;
});

describe("probeDevice", () => {
  it("reports no Prompt API in a plain browser", async () => {
    const status = await probeDevice();
    expect(status.supported).toBe(false);
    expect(status.availability).toBe("unavailable");
    expect(status.note).toMatch(/Chrome 139/);
  });

  it("passes availability through verbatim", async () => {
    scope.LanguageModel = { availability: async () => "downloadable" };
    const status = await probeDevice();
    expect(status.supported).toBe(true);
    expect(status.availability).toBe("downloadable");
    expect(status.note).toMatch(/installed/);
    expect(isDeviceReady(status)).toBe(false);
  });

  it("says a ready model can take private documents", async () => {
    scope.LanguageModel = { availability: async () => "available" };
    const status = await probeDevice();
    expect(isDeviceReady(status)).toBe(true);
    expect(status.note).toMatch(/ready/);
  });

  it("understands the older ai.languageModel shape and its vocabulary", async () => {
    scope.ai = { languageModel: { capabilities: async () => ({ available: "readily" }) } };
    const status = await probeDevice();
    expect(status.availability).toBe("available");

    scope.ai = { languageModel: { capabilities: async () => ({ available: "after-download" }) } };
    expect((await probeDevice()).availability).toBe("downloadable");
  });

  it("turns a probe failure into unknown, not into a crash", async () => {
    scope.LanguageModel = {
      availability: async () => {
        throw new Error("boom");
      },
    };
    const status = await probeDevice();
    expect(status.supported).toBe(true);
    expect(status.availability).toBe("unknown");
    expect(status.note).toMatch(/boom/);
  });
});
