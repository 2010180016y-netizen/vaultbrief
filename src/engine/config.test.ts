// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_CONFIG,
  loadLocalConfig,
  loadConfig,
  parseFirebaseConfigPaste,
  saveAppCheck,
  clearAppCheck,
  saveLocalConfig,
} from "./config";
import { DEFAULT_WEBLLM_MODEL } from "./webllm";

describe("parseFirebaseConfigPaste", () => {
  it("reads the JSON the Firebase console shows", () => {
    const parsed = parseFirebaseConfigPaste(
      JSON.stringify({
        apiKey: "AIzaSyExample",
        authDomain: "demo.firebaseapp.com",
        projectId: "demo-project",
        appId: "1:1:web:abc",
        storageBucket: "demo.appspot.com",
        messagingSenderId: "123",
      }),
    );
    expect(parsed?.projectId).toBe("demo-project");
    expect(parsed?.apiKey).toBe("AIzaSyExample");
    expect(parsed?.authDomain).toBe("demo.firebaseapp.com");
  });

  it("reads the const firebaseConfig = {...}; snippet", () => {
    const parsed = parseFirebaseConfigPaste(
      `const firebaseConfig = {\n  apiKey: "AIzaSyExample",\n  projectId: "demo-project",\n};`,
    );
    expect(parsed?.projectId).toBe("demo-project");
  });

  it("tolerates a trailing comma", () => {
    const parsed = parseFirebaseConfigPaste('{"apiKey":"k","projectId":"p",}');
    expect(parsed?.projectId).toBe("p");
  });

  it("rejects text that is not a config", () => {
    expect(parseFirebaseConfigPaste("")).toBeNull();
    expect(parseFirebaseConfigPaste("hello")).toBeNull();
    expect(parseFirebaseConfigPaste('{"apiKey":"k"}')).toBeNull();
    expect(parseFirebaseConfigPaste('{"projectId":"p"}')).toBeNull();
    expect(parseFirebaseConfigPaste('{"apiKey":"k","projectId":"two words"}')).toBeNull();
  });
});

describe("configuration storage", () => {
  it("keeps App Check settings and clears them on request", () => {
    saveAppCheck({ debugToken: "  token-123  " });
    // Stored values are read back by loadConfig through localStorage.
    expect(loadConfig().appCheck.debugToken).toBe("token-123");
    clearAppCheck();
    expect(loadConfig().appCheck.debugToken).toBeUndefined();
  });

  it("reports what is missing for the live path", () => {
    const config = loadConfig();
    expect(config.firebase).toBeNull();
    expect(config.missing.join(" ")).toMatch(/No Firebase config/);
  });
});

describe("local model settings", () => {
  it("defaults to auto with the compact WebLLM model and embeddings on", () => {
    expect(DEFAULT_LOCAL_CONFIG.engine).toBe("auto");
    expect(DEFAULT_LOCAL_CONFIG.embeddings).toBe(true);
    expect(loadLocalConfig()).toEqual(DEFAULT_LOCAL_CONFIG);
  });

  it("keeps the default WebLLM model in sync with the catalogue", () => {
    expect(DEFAULT_LOCAL_CONFIG.webllmModel).toBe(DEFAULT_WEBLLM_MODEL);
  });

  it("round-trips the engine choice and rejects nonsense", () => {
    saveLocalConfig({ engine: "webllm", webllmModel: "Llama-3.2-1B-Instruct-q4f16_1-MLC", embeddings: false });
    const stored = loadLocalConfig();
    expect(stored.engine).toBe("webllm");
    expect(stored.embeddings).toBe(false);
    expect(stored.webllmModel).toBe("Llama-3.2-1B-Instruct-q4f16_1-MLC");

    globalThis.localStorage?.setItem("vaultbrief.local.v1", JSON.stringify({ engine: "telepathy" }));
    expect(loadLocalConfig().engine).toBe("auto");
  });
});
