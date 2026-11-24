import { describe, expect, it } from "vitest";
import { hybridParams } from "./hybrid";
import { BRIEF_SCHEMA } from "./prompt";

describe("hybridParams", () => {
  it("builds one parameter set for the SDK's four modes", () => {
    for (const mode of ["prefer_on_device", "only_on_device", "prefer_in_cloud", "only_in_cloud"] as const) {
      const params = hybridParams(mode, "gemini-3.5-flash-lite");
      expect(params.mode).toBe(mode);
      expect(params.inCloudParams.model).toBe("gemini-3.5-flash-lite");
    }
  });

  it("uses the same JSON schema as the prompt layer", () => {
    const params = hybridParams("prefer_in_cloud", "m");
    expect(params.inCloudParams.generationConfig.responseMimeType).toBe("application/json");
    expect(params.inCloudParams.generationConfig.responseJsonSchema).toBe(BRIEF_SCHEMA);
    expect(params.inCloudParams.generationConfig.responseJsonSchema.required).toEqual([
      "title",
      "tldr",
      "points",
      "flags",
    ]);
  });

  it("probes and creates the on-device model with identical options", () => {
    // device.ts probes availability with expectedInputs/expectedOutputs; a
    // mismatch there makes availability() answer for a different model.
    const params = hybridParams("only_on_device", "m");
    expect(params.onDeviceParams.createOptions.expectedInputs).toEqual([{ type: "text", languages: ["en"] }]);
    expect(params.onDeviceParams.createOptions.expectedOutputs).toEqual([{ type: "text", languages: ["en"] }]);
    expect(params.onDeviceParams.createOptions.initialPrompts[0].role).toBe("system");
  });

  it("keeps the cloud model name configurable per call", () => {
    const params = hybridParams("prefer_in_cloud", "gemini-from-remote-config");
    expect(params.inCloudParams.model).toBe("gemini-from-remote-config");
  });
});
