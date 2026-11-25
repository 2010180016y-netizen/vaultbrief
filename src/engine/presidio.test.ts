import { describe, expect, it } from "vitest";
import { analyze, anonymize, applyOperator, statsFor, contextMatches } from "./presidio";
import { maskDocument } from "./pii";
import { brnValid, driverLicenceValid, ibanValid, luhn, rrnValid, usSsnValid } from "./checksums";

const types = (text: string, threshold = 0.4) =>
  analyze(text, { scoreThreshold: threshold }).map((r) => r.entity_type);

const scoreOf = (text: string, entity: string) =>
  analyze(text).find((r) => r.entity_type === entity)?.score ?? 0;

describe("Presidio recognizers", () => {
  it("finds the English entities Presidio's default registry covers", () => {
    const text = "Contact Jane Doe at jane.doe@example.com or +1 415 555 0134.";
    const found = analyze(text);
    expect(found.map((r) => r.entity_type)).toEqual(
      expect.arrayContaining(["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER"]),
    );
    const person = found.find((r) => r.entity_type === "PERSON")!;
    expect(text.slice(person.start, person.end)).toBe("Jane Doe");
    expect(person.analysis_explanation.recognizer).toBe("PersonRecognizer");
  });

  it("validates a card number and lowers the confidence of a Luhn failure", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(scoreOf("card 4111 1111 1111 1111", "CREDIT_CARD")).toBe(1);
    expect(scoreOf("4111 1111 1111 1112", "CREDIT_CARD")).toBeLessThan(0.4);
  });

  it("finds an IBAN that the keyword scan cannot see", () => {
    const results = analyze("Send it to GB82WEST12345698765432 today.");
    expect(results.map((r) => r.entity_type)).toContain("IBAN_CODE");
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82WEST12345698765433")).toBe(false);
  });

  it("validates Korean resident numbers with the real check digit", () => {
    // 900101-1234568 is a well-known checksum-valid test number.
    expect(rrnValid("900101-1234568")).toBe(true);
    expect(rrnValid("900315-1234567")).toBe(false);
    const valid = analyze("주민등록번호: 900101-1234568");
    expect(valid[0].entity_type).toBe("KR_RRN");
    expect(valid[0].analysis_explanation.validation_result).toBe(true);
    expect(valid[0].score).toBeGreaterThan(0.9);
    // A failing check digit is still PII: test data is usually invalid.
    const invalid = analyze("주민등록번호: 900315-1234567");
    expect(invalid[0].entity_type).toBe("KR_RRN");
    expect(invalid[0].score).toBeGreaterThanOrEqual(0.6);
  });

  it("validates Korean business numbers, licences and passports", () => {
    expect(brnValid("123-45-67896")).toBe(true);
    expect(brnValid("123-45-67890")).toBe(false);
    expect(driverLicenceValid("11-22-123456-01")).toBe(true);
    expect(driverLicenceValid("99-22-123456-01")).toBe(false);
    expect(usSsnValid("123-45-6789")).toBe(true);
    expect(usSsnValid("666-45-6789")).toBe(false);

    const licence = analyze("운전면허 11-22-123456-01, 여권 M12345678");
    expect(licence.map((r) => r.entity_type)).toEqual(
      expect.arrayContaining(["KR_DRIVER_LICENSE", "KR_PASSPORT"]),
    );
  });

  it("raises confidence when a context word sits in front of the value", () => {
    // Presidio's LemmaContextAwareEnhancer behaviour: same digits, different context.
    const bare = analyze("번호 123-456-789012", { scoreThreshold: 0.01 });
    const contextual = analyze("계좌번호 123-456-789012", { scoreThreshold: 0.01 });
    const bareAccount = bare.find((r) => r.entity_type === "KR_ACCOUNT")!;
    const withContext = contextual.find((r) => r.entity_type === "KR_ACCOUNT")!;
    expect(bareAccount.score).toBeLessThan(0.4);
    expect(withContext.score).toBeGreaterThan(bareAccount.score);
    expect(withContext.analysis_explanation.supportive_context_word).toBeTruthy();
    expect(contextMatches("계좌번호:", "계좌")).toBe(true);
    expect(contextMatches("연락처:", "계좌")).toBe(false);
  });

  it("keeps the highest scoring span when two recognizers overlap", () => {
    const results = analyze("연락처 010-2841-7734");
    expect(results.filter((r) => r.entity_type === "PHONE_NUMBER")).toHaveLength(1);
    expect(results.some((r) => r.entity_type === "KR_ACCOUNT")).toBe(false);
  });

  it("respects the entities filter and the score threshold", () => {
    const text = "jane@example.com 010-2841-7734";
    expect(analyze(text, { entities: ["EMAIL_ADDRESS"] }).map((r) => r.entity_type)).toEqual([
      "EMAIL_ADDRESS",
    ]);
    expect(analyze("010-2841-7734", { scoreThreshold: 0.9 }).length).toBe(0);
  });

  it("counts validated and context-boosted entities", () => {
    const stats = statsFor(analyze("계좌번호 123-456-789012 and jane@example.com"));
    expect(stats.entities).toBeGreaterThanOrEqual(2);
    expect(stats.contextBoosted).toBeGreaterThan(0);
    expect(stats.byEntity.EMAIL_ADDRESS).toBe(1);
  });
});

describe("Presidio anonymizer", () => {
  const text = "Contact Jane Doe at jane.doe@example.com, card 4111 1111 1111 1111.";
  const results = () => analyze(text);

  it("replaces spans with typed placeholders", () => {
    const { text: masked, items } = anonymize(text, results());
    expect(masked).toContain("<EMAIL_ADDRESS>");
    expect(masked).toContain("<PERSON>");
    expect(masked).toContain("<CREDIT_CARD>");
    expect(masked).not.toContain("jane.doe@example.com");
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((item) => item.operator === "replace")).toBe(true);
  });

  it("supports redact, mask, hash, keep and custom new values", () => {
    expect(applyOperator("jane@example.com", "EMAIL_ADDRESS", { operator: "redact" })).toBe("");
    expect(applyOperator("4111111111111111", "CREDIT_CARD", { operator: "mask", fromEnd: true, charsToMask: 4 })).toBe(
      "411111111111****",
    );
    const hashed = applyOperator("jane@example.com", "EMAIL_ADDRESS", { operator: "hash" });
    expect(hashed).toMatch(/^[0-9a-f]{16}$/);
    expect(applyOperator("jane@example.com", "EMAIL_ADDRESS", { operator: "hash" })).toBe(hashed);
    expect(applyOperator("x", "PERSON", { operator: "keep" })).toBe("x");
    expect(applyOperator("x", "PERSON", { operator: "replace", newValue: "[REDACTED:IDENTITY]" })).toBe(
      "[REDACTED:IDENTITY]",
    );
  });

  it("applies a per-entity operator map", () => {
    const { text: masked } = anonymize(text, results(), {
      PERSON: { operator: "replace", newValue: "[NAME]" },
      DEFAULT: "redact",
    });
    expect(masked).toContain("[NAME]");
    expect(masked).not.toContain("4111");
    expect(masked).toContain("Contact [NAME] at , card .".slice(0, 13));
  });

  it("does not double-rewrite overlapping results", () => {
    const { items } = anonymize("010-2841-7734", analyze("연락처 010-2841-7734"));
    expect(items).toHaveLength(1);
  });
});

describe("checksum helpers", () => {
  it("rejects obviously invalid values instead of trusting the shape", () => {
    expect(luhn("1234567890123456")).toBe(false);
    expect(ibanValid("GB00WEST12345698765432")).toBe(false);
    expect(driverLicenceValid("11-22-1234")).toBe(false);
    expect(usSsnValid("000-12-3456")).toBe(false);
    expect(types("reference 1234 5678 9012 3459 was declined")).not.toContain("CREDIT_CARD");
  });
});

describe("Korean names beyond field labels", () => {
  const names = (text: string) =>
    analyze(text)
      .filter((result) => result.entity_type === "PERSON")
      .map((result) => text.slice(result.start, result.end));

  it("finds a name that carries an honorific instead of a label", () => {
    const text = "김민수 씨는 3일 전부터 상복부 통증을 호소했고, 이지훈 과장이 내시경을 시행했다.";
    const found = names(text);
    expect(found).toContain("김민수");
    expect(found).toContain("이지훈");
  });

  it("does not turn a polite noun into a person", () => {
    const text = "고객님께 안내드립니다. 회원님과 담당자님께서 확인하실 수 있습니다.";
    // 고객/회원/담당 are stopwords; 담당자 is three syllables and not in the list,
    // so the recognizer may still fire there — but it must not invent 고객/회원.
    const found = names(text);
    expect(found).not.toContain("고객");
    expect(found).not.toContain("회원");
  });

  it("masks the honorific name while keeping the sentence readable", () => {
    const { text } = maskDocument("상담자: 김민수 씨, 연락처 010-2841-7734.");
    expect(text).not.toContain("김민수");
    expect(text).toContain("[REDACTED:IDENTITY]");
    expect(text).not.toContain("010-2841-7734");
  });
});
