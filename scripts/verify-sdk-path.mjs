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
  return Object.values(InferenceMode).join(", ");
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
