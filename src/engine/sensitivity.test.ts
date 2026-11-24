import { describe, expect, it } from "vitest";
import { SAMPLES } from "./samples";
import { luhn, redact, scan, SENSITIVE_THRESHOLD } from "./sensitivity";

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
