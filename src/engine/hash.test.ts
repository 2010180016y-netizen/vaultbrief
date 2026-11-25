import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64Decode, base64Encode, canonicalJson, sha256Hex, shortDigest } from "./hash";

describe("sha256Hex", () => {
  it("matches the published NIST vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("agrees with node:crypto across lengths that hit every padding case", () => {
    const inputs = [
      "a",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "가나다라마바사".repeat(9),
      "Mixed 한글 and ASCII — with punctuation, 1234567890.",
    ];
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    }
  });

  it("handles multi-byte characters by their UTF-8 bytes", () => {
    const text = "주민등록번호 900315-1234567";
    expect(sha256Hex(text)).toBe(createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"));
  });
});

describe("canonicalJson", () => {
  it("does not depend on key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: { d: 4, c: 3 }, a: [1, 2] })).toBe('{"a":[1,2],"b":{"c":3,"d":4}}');
  });

  it("keeps array order, which is part of the meaning", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("drops undefined members the way JSON.stringify does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("handles null, booleans, numbers and strings", () => {
    expect(canonicalJson({ a: null, b: true, c: 1.5, d: "x" })).toBe('{"a":null,"b":true,"c":1.5,"d":"x"}');
  });
});

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect([...base64Decode(base64Encode(bytes))]).toEqual([...bytes]);
  });

  it("produces a short, stable digest prefix", () => {
    expect(shortDigest("0123456789abcdef", 8)).toBe("01234567");
  });
});
