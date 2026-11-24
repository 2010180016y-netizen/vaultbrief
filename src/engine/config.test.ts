// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseFirebaseConfigPaste, saveAppCheck, clearAppCheck, loadConfig } from "./config";

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
