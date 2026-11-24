import { describe, expect, it } from "vitest";
import { SAMPLES } from "./samples";
import { keywordPattern, luhn, redact, scan, SENSITIVE_THRESHOLD } from "./sensitivity";

describe("sensitivity scan", () => {
  it("finds contact, identity and payment signals", () => {
    const result = scan(
      "Write to jane.doe@example.com or call +1 415 555 0134. Resident 900315-1234567, card 4111 1111 1111 1111.",
    );
    const labels = result.detections.map((d) => d.label);
    expect(labels).toContain("Email address");
    expect(labels).toContain("Phone number");
    expect(labels).toContain("Korean resident registration number");
    expect(labels).toContain("Payment card number");
    expect(result.score).toBeGreaterThanOrEqual(SENSITIVE_THRESHOLD);
  });

  it("rejects card-shaped numbers that fail the Luhn check", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    const result = scan("Reference 1234 5678 9012 3459 was declined.");
    expect(result.detections.find((d) => d.label === "Payment card number")).toBeUndefined();
  });

  it("scores credentials highest", () => {
    const result = scan("config: api_key = sk-live-9f8e7d6c5b4a3210");
    expect(result.score).toBeGreaterThanOrEqual(55);
    expect(result.detections[0].category).toBe("credential");
  });

  it("catches provider tokens that appear without a label", () => {
    const aws = scan("credentials AKIAIOSFODNN7EXAMPLE leaked");
    expect(aws.detections.map((d) => d.label)).toContain("API key / access token");
    const github = scan("push with ghp_abc123def456ghi789jkl012mno345pqr678");
    expect(github.score).toBeGreaterThanOrEqual(60);
    const { text } = redact("AWS AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts every span and keeps placeholders typed", () => {
    const text = "Mail jane.doe@example.com, phone 010-2841-7734, 주민 900315-1234567.";
    const { text: masked, replaced } = redact(text);
    expect(replaced).toBe(3);
    expect(masked).toContain("[REDACTED:CONTACT]");
    expect(masked).toContain("[REDACTED:GOVERNMENT_ID]");
    expect(masked).not.toContain("jane.doe@example.com");
    expect(masked).not.toContain("900315-1234567");
    // A second pass finds nothing: the masking is idempotent.
    expect(scan(masked).hits).toBe(0);
  });

  it("does not mask numbers that are not identifiers", () => {
    const { replaced } = redact("Revenue grew 18% in Q3, with 2,400 shipments and 12 markets.");
    expect(replaced).toBe(0);
  });

  it("raises the score with keywords but never rewrites ordinary words", () => {
    const text = "The patient was diagnosed and the prescription was collected.";
    expect(scan(text).score).toBeGreaterThan(0);
    const { text: masked, replaced } = redact(text);
    expect(replaced).toBe(0);
    expect(masked).toBe(text);
  });

  it("masks a named person but keeps the field label", () => {
    const { text: masked } = redact("Patient: Daniel R. Okafor, DOB 1988-03-14");
    expect(masked).toContain("Patient: [REDACTED:IDENTITY]");
    expect(masked).not.toContain("Okafor");
    expect(masked).not.toContain("1988");
    expect(masked).toContain("DOB: [REDACTED:IDENTITY]");
  });

  it("leaves the public newsletter below the threshold", () => {
    const newsletter = SAMPLES.find((s) => s.id === "brief")!;
    const result = scan(newsletter.text);
    expect(result.score).toBeLessThan(SENSITIVE_THRESHOLD);
  });

  it("flags the private samples", () => {
    for (const id of ["discharge", "nda", "korean-record"]) {
      const sample = SAMPLES.find((s) => s.id === id)!;
      const result = scan(sample.text);
      expect(result.score, `${id} score`).toBeGreaterThanOrEqual(SENSITIVE_THRESHOLD);
      expect(result.redactable, `${id} redactable`).toBeGreaterThan(0);
    }
  });

  it("handles empty and huge input without throwing", () => {
    expect(scan("").score).toBe(0);
    const huge = "The committee met again. ".repeat(4000);
    expect(scan(huge).score).toBeLessThan(SENSITIVE_THRESHOLD);
  });
});

describe("Korean text", () => {
  // Regression: /\b진단\b/ never matches in JavaScript, because \b is defined on
  // ASCII word characters. Every Korean keyword signal used to be dead.
  it("keywordPattern matches Korean without a word boundary", () => {
    const pattern = keywordPattern(["진단", "처방"]);
    expect("진단명: 급성 위염".match(pattern)).not.toBeNull();
    expect("처방 내역".match(pattern)).not.toBeNull();
    expect("진단서".match(pattern)).not.toBeNull();
    expect("무관한 문장".match(pattern)).toBeNull();
  });

  it("flags a Korean medical document with no identifiers at all", () => {
    const result = scan("진단명: 급성 위염. 처방 내역: 판토프라졸 40mg. 병원 방문.");
    expect(result.detections.map((d) => d.label)).toContain("Health information");
    expect(result.score).toBeGreaterThanOrEqual(SENSITIVE_THRESHOLD);
  });

  it("flags Korean financial and legal wording", () => {
    expect(scan("급여 명세와 연봉 협상").detections.map((d) => d.label)).toContain("Financial information");
    expect(scan("비밀유지 조항과 손해배상 책임").detections.map((d) => d.label)).toContain("Contract / legal terms");
  });

  it("masks Korean identifiers and keeps the labels readable", () => {
    const text = "환자 성명: 김민수\n주민등록번호: 900315-1234567\n연락처: 010-2841-7734\n주소: 서울특별시 마포구 월드컵북로 41";
    const { text: masked, replaced } = redact(text);
    expect(replaced).toBe(4);
    expect(masked).toContain("환자 성명: [REDACTED:IDENTITY]");
    expect(masked).toContain("주민등록번호: [REDACTED:GOVERNMENT_ID]");
    expect(masked).toContain("주소: [REDACTED:CONTACT]");
    expect(masked).not.toContain("김민수");
    expect(masked).not.toContain("900315");
    expect(masked).not.toContain("월드컵북로");
    // The field labels survive, so the masked document is still readable.
    expect(masked.split("\n")).toHaveLength(4);
  });

  it("reports which topics a masked copy still reveals", () => {
    const result = scan(SAMPLES.find((s) => s.id === "korean-record")!.text);
    expect(result.residual).toContain("Health information");
    expect(result.unmaskable).toBeGreaterThan(0);
  });
});

describe("phone handling", () => {
  it("recognises Korean mobile, landline and +82 numbers", () => {
    for (const number of ["010-2841-7734", "02-1234-5678", "031-123-4567", "+82 10-2841-7734"]) {
      const labels = scan(`call ${number}`).detections.map((d) => d.label);
      expect(labels, number).toContain("Phone number");
    }
  });

  it("does not report a phone number as a bank account", () => {
    const result = scan("연락처 010-2841-7734");
    expect(result.detections.map((d) => d.label)).toEqual(["Phone number"]);
    expect(redact("연락처 010-2841-7734").text).toBe("연락처 [REDACTED:CONTACT]");
  });

  it("counts an overlapping span once", () => {
    // 010-2841-7734 fits both the phone and the account pattern.
    expect(scan("010-2841-7734").hits).toBe(1);
  });
});
