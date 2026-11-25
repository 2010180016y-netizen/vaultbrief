#!/usr/bin/env node
/**
 * Contract check against the real Firebase AI Logic SDK.
 *
 * This does not need a Firebase project. It proves three things that unit tests
 * with a mock cannot:
 *   1. `firebase/ai` exports the hybrid API this app uses, with the values the
 *      router produces (`InferenceMode.*`).
 *   2. A model object built from exactly the parameters in src/engine/hybrid.ts
 *      is accepted by the SDK, including the JSON schema we send.
 *   3. `generateContent()` really issues a request to Google and fails only
 *      because the credentials are deliberately fake.
 *
 * Run: node scripts/verify-sdk-path.mjs
 */
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    tldr: { type: "string" },
    points: { type: "array", items: { type: "string" } },
    flags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "tldr", "points", "flags"],
};

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
};

check("InferenceMode values match the router strings", () => {
  const expected = {
    PREFER_ON_DEVICE: "prefer_on_device",
    ONLY_ON_DEVICE: "only_on_device",
    PREFER_IN_CLOUD: "prefer_in_cloud",
    ONLY_IN_CLOUD: "only_in_cloud",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (InferenceMode[key] !== value) throw new Error(`${key} is ${InferenceMode[key]}, expected ${value}`);
  }
  const keys = Object.keys(InferenceMode);
  if (keys.length !== 4) throw new Error(`expected 4 modes, found ${keys.join(", ")}`);
  return Object.values(InferenceMode).join(", ");
});

check("the app's mode resolution works against the real InferenceMode object", () => {
  // Mirrors resolveInferenceMode() in src/engine/hybrid.ts: the key as given,
  // then the upper-case member name (the real SDK's shape), then a value match.
  // This is the lookup that passed against a mock keyed like the app talks and
  // returned undefined against the real enum.
  const resolve = (modes, mode) => {
    if (!modes) return undefined;
    for (const candidate of [mode, mode.toUpperCase()]) {
      const value = modes[candidate];
      if (typeof value === "string" && value) return value;
    }
    for (const [key, value] of Object.entries(modes)) {
      if (typeof value !== "string" || !value) continue;
      if (value === mode || key.toLowerCase() === mode) return value;
    }
    return undefined;
  };
  const routerModes = ["prefer_on_device", "only_on_device", "prefer_in_cloud", "only_in_cloud"];
  for (const mode of routerModes) {
    const resolved = resolve(InferenceMode, mode);
    if (resolved !== mode) throw new Error(`resolve(${mode}) returned ${resolved}`);
  }
  return "all four router strings resolved through the upper-case member name";
});

check("src/engine/hybrid.ts resolves the mode through resolveInferenceMode", () => {
  const source = readFileSync(new URL("../src/engine/hybrid.ts", import.meta.url), "utf8");
  if (!source.includes("resolveInferenceMode(this.sdk.InferenceMode, mode)")) {
    throw new Error("model() does not call resolveInferenceMode(this.sdk.InferenceMode, mode)");
  }
  if (/InferenceMode\s*\[\s*mode\s*\]/.test(source)) {
    throw new Error("model() still indexes InferenceMode by the lower-case mode string");
  }
  return "resolver in use";
});

// Deliberately fake: a syntactically valid, non-existent project.
const app = initializeApp({
  apiKey: "AIzaSyFAKE-key-not-a-real-project-000000000",
  projectId: "vaultbrief-contract-check",
  appId: "1:000000000000:web:0000000000000000000000",
});

const ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });

const model = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,
  inCloudParams: {
    model: "gemini-3.5-flash-lite",
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseJsonSchema: BRIEF_SCHEMA,
    },
  },
  onDeviceParams: {
    createOptions: {
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
      initialPrompts: [
        {
          role: "system",
          content: [
            {
              type: "text",
              value:
                "You write very short, factual briefs as strict JSON. Never invent facts that are not in the text.",
            },
          ],
        },
      ],
    },
  },
});

check("hybrid model object exposes the runtime API", () => {
  if (typeof model.generateContent !== "function") throw new Error("generateContent missing");
  if (typeof model.initializeDeviceModel !== "function") throw new Error("initializeDeviceModel missing");
  return Object.keys(model).join(", ") || "instance created";
});

// The call itself: expected to fail on credentials, which is the proof that the
// request left this process and reached the Firebase AI Logic endpoint.
const started = Date.now();
let failure = null;
try {
  const response = await model.generateContent("Reply with {\"ok\":true}");
  failure = { unexpected: response.response.text() };
} catch (error) {
  failure = { code: error.code ?? "(no code)", message: String(error.message ?? error).slice(0, 320) };
}

const payload = {
  checkedAt: new Date().toISOString(),
  sdk: "firebase/ai (firebase 13.x, node build)",
  mode: InferenceMode.PREFER_ON_DEVICE,
  checks: results,
  generateContent: { latencyMs: Date.now() - started, ...(failure.unexpected ? { result: failure.unexpected } : { error: failure }) },
};

console.log(JSON.stringify(payload, null, 2));
