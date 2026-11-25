/**
 * Checksum and format validators for identifier recognizers.
 *
 * Regexes alone cannot tell a real Korean resident number from a 13-digit SKU,
 * and an invalid check digit is exactly the signal Presidio's `validate_result`
 * uses to lower a match's confidence. Every validator here is used by
 * `presidio/recognizers.ts`; none of them needs a model or the network.
 */

/** Luhn (ISO/IEC 7812) — payment card numbers. */
export function luhn(digits: string): boolean {
  if (digits.length < 13) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (Number.isNaN(d)) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ISO 7064 mod 97-10 — IBAN. */
export function ibanValid(iban: string): boolean {
  const compact = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Digits of a Korean resident / foreigner registration number, separators removed. */
export function rrnDigits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/**
 * Korean resident registration number check digit (주민등록번호 검증식).
 *
 * Weights 2,3,4,5,6,7,8,9,2,3,4,5 over the first twelve digits; the final
 * digit is `(11 − sum mod 11) mod 10`. Foreigners (7th digit 5–8) add 2 before
 * the mod. A number can be well-formed and still fail this (test data usually
 * does), so callers treat a failure as lower confidence, not as "not PII".
 */
export function rrnValid(value: string): boolean {
  const digits = rrnDigits(value);
  if (digits.length !== 13) return false;
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const gender = Number(digits[6]);
  if (gender < 1 || gender > 8) return false;
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * weights[i];
  if (gender >= 5) sum += 2;
  const expected = (11 - (sum % 11)) % 10;
  return expected === Number(digits[12]) && yy >= 0;
}

/** Korean business registration number (사업자등록번호) checksum. */
export function brnValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length !== 10) return false;
  const weights = [1, 3, 7, 1, 3, 7, 1, 3];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(digits[i]) * weights[i];
  // The ninth digit is weighted by 5 and only its tens digit is added.
  sum += Math.floor((Number(digits[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(digits[9]);
}

/**
 * Korean driver licence: 12 digits in the `11-22-123456-01` layout, where the
 * first two digits are the issuing region (11–28). The trailing pair is an
 * office-specific check pair whose algorithm is not published consistently, so
 * only the region code and the length are verified — the recognizer is careful
 * not to claim a checksum it cannot prove.
 */
export function driverLicenceValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length !== 12) return false;
  const region = Number(digits.slice(0, 2));
  if (region < 11 || region > 28) return false;
  return !/^0+$/.test(digits);
}

/** Korean passport: one letter (M/S/R/O/D) + 8 digits. */
export function krPassportValid(value: string): boolean {
  return /^[MSROD]\d{8}$/.test(value.replace(/\s/g, "").toUpperCase());
}

/** US Social Security Number range rules (SSA). */
export function usSsnValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length !== 9) return false;
  const area = Number(digits.slice(0, 3));
  const group = Number(digits.slice(3, 5));
  const serial = Number(digits.slice(5));
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

/** A plausible calendar date, used to keep date-shaped numbers honest. */
export function dateValid(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const max = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= max;
}

/** FNV-1a 64-bit, hex. A stable pseudonym for hashed output (not cryptographic). */
export function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
