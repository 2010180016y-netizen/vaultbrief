import {
  brnValid,
  dateValid,
  driverLicenceValid,
  ibanValid,
  krPassportValid,
  luhn,
  rrnDigits,
  rrnValid,
  usSsnValid,
} from "../checksums";
import type { RecognizerDefinition } from "./types";

/**
 * Recognizer registry.
 *
 * The English recognizers mirror microsoft/presidio's default registry (same
 * entity names, same idea of a pattern score plus a `validate_result` step).
 * Presidio's NER recognizers need spaCy; in a browser tab we cannot ship a
 * 40 MB model, so PERSON and LOCATION use anchored, context-bearing patterns
 * instead of NER. What we add on top of stock Presidio is the Korean set —
 * resident numbers with a real check digit, business numbers, driver licences,
 * passports and bank accounts — which stock Presidio does not cover at all.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE =
  /(?<!\d)(?:\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,9}|0(?:1[016789]|[2-6]\d?)[-\s]?\d{3,4}[-\s]?\d{4})(?!\d)/g;
const CARD = /(?<![\d-])(?:\d[ -]?){13,19}(?![\d-])/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const IP =
  /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\d.])/g;
const URL = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const US_SSN = /(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)/g;

const KR_RRN = /(?<!\d)\d{6}[-\s]?[1-8]\d{6}(?!\d)/g;
const KR_BRN = /(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/g;
const KR_DRIVER = /(?<!\d)\d{2}-\d{2}-\d{6}-\d{2}(?!\d)/g;
const KR_PASSPORT = /(?<![A-Za-z0-9])[MSROD]\d{8}(?![0-9])/g;
const KR_ACCOUNT = /(?<!\d)\d{2,6}-\d{2,6}-\d{4,8}(?!\d)/g;
const DATE = /(?<!\d)\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)/g;

/** Korean field labels: the value follows the label, so the label is genuine context. */
const KR_NAME = /(?:성명|이름|환자명|수진자|담당\s*의사|신청인|대표자|근로자|직원|보호자)\s*[:：]?\s*([가-힣]{2,4})/g;

/** Case-insensitive rendering of a keyword, so a label can start a sentence. */
const ci = (word: string) =>
  [...word]
    .map((char) => (/[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char))
    .join("");

const NAME_LABELS = [
  "patient",
  "employee",
  "applicant",
  "signatory",
  "candidate",
  "contact",
  "attending",
  "insured",
  "claimant",
  "witness",
  "customer",
  "client",
  "prepared by",
  "signed by",
  "submitted by",
]
  .map((word) => ci(word).replace(/ /g, "\\s+"))
  .join("|");
const TITLES = ["Mr", "Ms", "Mrs", "Dr", "Prof"].map(ci).join("|");

const EN_NAME = new RegExp(
  `(?:\\b(?:${NAME_LABELS})\\b|\\b(?:${TITLES})\\b)\\.?\\s*[:：]?\\s*([A-Z][a-z'’-][a-zA-Z'’-]*(?:\\s+(?:[A-Z]\\.?\\s*)?[A-Z][a-z'’-][a-zA-Z'’-]*){0,2})`,
  "g",
);
const EN_TITLE_NAME = new RegExp(`\\b(?:${TITLES})\\.\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)`, "g");

const KR_ADDRESS =
  /(?:[가-힣]{2,10}(?:특별시|광역시|특별자치시|특별자치도|도)\s+)?[가-힣]{1,10}(?:시|군|구)\s+[가-힣0-9]{1,12}(?:로|길|동|읍|면)\s*\d{0,5}(?:\s*[가-힣0-9-]{1,10}(?:로|길|동|호|층))?/g;
const EN_ADDRESS =
  /\d{1,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Boulevard|Blvd|Drive|Dr|Parkway|Pkwy|Way|Court|Ct|Place|Pl|Terrace|Highway|Hwy)\.?/g;

export const RECOGNIZERS: RecognizerDefinition[] = [
  {
    entityType: "EMAIL_ADDRESS",
    name: "EmailRecognizer",
    category: "contact",
    label: "Email address",
    patterns: [{ name: "email", regex: EMAIL, score: 1 }],
    context: ["email", "mail", "contact", "이메일", "메일"],
    weight: 14,
    redactable: true,
  },
  {
    entityType: "CREDIT_CARD",
    name: "CreditCardRecognizer",
    category: "payment",
    label: "Payment card number",
    patterns: [{ name: "card", regex: CARD, score: 1 }],
    context: ["card", "visa", "mastercard", "amex", "credit", "debit", "카드", "결제"],
    validate: (value) =>
      luhn(value.replace(/[^0-9]/g, ""))
        ? { valid: true, score: 1 }
        : { valid: false, score: 0.3, note: "Luhn check failed" },
    weight: 45,
    redactable: true,
  },
  {
    entityType: "KR_RRN",
    name: "KrRrnRecognizer",
    category: "government_id",
    label: "Korean resident registration number",
    patterns: [{ name: "rrn", regex: KR_RRN, score: 0.6 }],
    context: ["주민", "주민등록", "등록번호", "주민번호", "resident", "rrn", "social security"],
    validate: (value) => {
      const digits = rrnDigits(value);
      if (digits.length !== 13) return { valid: false, score: 0.5 };
      const month = Number(digits.slice(2, 4));
      const day = Number(digits.slice(4, 6));
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return { valid: false, score: 0.45, note: "impossible birth date" };
      }
      // A real resident number earns full confidence; a well-formed but failing
      // check digit stays PII (test data is usually invalid) at a lower score.
      return rrnValid(value)
        ? { valid: true, score: 1 }
        : { valid: false, score: 0.65, note: "check digit mismatch" };
    },
    weight: 50,
    redactable: true,
  },
  {
    entityType: "KR_BRN",
    name: "KrBusinessRegistrationRecognizer",
    category: "financial",
    label: "Korean business registration number",
    patterns: [{ name: "brn", regex: KR_BRN, score: 0.4 }],
    context: ["사업자", "등록번호", "법인", "business", "registration", "사업자등록"],
    validate: (value) => (brnValid(value) ? { valid: true, score: 0.9 } : { valid: false, score: 0.35 }),
    weight: 30,
    redactable: true,
  },
  {
    entityType: "KR_DRIVER_LICENSE",
    name: "KrDriverLicenceRecognizer",
    category: "government_id",
    label: "Korean driver licence number",
    patterns: [{ name: "driver-licence", regex: KR_DRIVER, score: 0.45 }],
    context: ["운전면허", "면허", "licence", "license", "driver"],
    validate: (value) =>
      driverLicenceValid(value) ? { valid: true, score: 0.7, note: "region code and length verified" } : { valid: false, score: 0.4 },
    weight: 32,
    redactable: true,
  },
  {
    entityType: "KR_PASSPORT",
    name: "KrPassportRecognizer",
    category: "government_id",
    label: "Passport number",
    patterns: [{ name: "passport", regex: KR_PASSPORT, score: 0.45 }],
    context: ["여권", "passport", "travel document"],
    validate: (value) =>
      krPassportValid(value) ? { valid: true, score: 0.75 } : { valid: false, score: 0.4 },
    weight: 36,
    redactable: true,
  },
  {
    entityType: "KR_ACCOUNT",
    name: "KrBankAccountRecognizer",
    category: "financial",
    label: "Bank account number",
    patterns: [{ name: "account", regex: KR_ACCOUNT, score: 0.35 }],
    context: ["계좌", "계좌번호", "은행", "입금", "송금", "예금", "account", "bank", "transfer"],
    validate: (value) => {
      const digits = value.replace(/[^0-9]/g, "");
      return digits.length >= 10 && digits.length <= 16
        ? { valid: true }
        : { valid: false, score: 0.3, note: "implausible length" };
    },
    weight: 30,
    redactable: true,
  },
  {
    entityType: "PHONE_NUMBER",
    name: "PhoneRecognizer",
    category: "contact",
    label: "Phone number",
    patterns: [{ name: "phone", regex: PHONE, score: 0.6 }],
    context: ["phone", "call", "tel", "mobile", "cell", "number", "contact", "연락처", "전화", "휴대폰", "핸드폰"],
    validate: (value) => {
      const digits = value.replace(/[^0-9]/g, "");
      return digits.length >= 9 && digits.length <= 15
        ? { valid: true, score: 0.75 }
        : { valid: false, score: 0.3 };
    },
    weight: 16,
    redactable: true,
  },
  {
    entityType: "IBAN_CODE",
    name: "IbanRecognizer",
    category: "financial",
    label: "IBAN",
    patterns: [{ name: "iban", regex: IBAN, score: 0.5 }],
    context: ["iban", "bank", "account", "송금", "계좌"],
    validate: (value) => (ibanValid(value) ? { valid: true, score: 1 } : { valid: false, score: 0.35 }),
    weight: 40,
    redactable: true,
  },
  {
    entityType: "US_SSN",
    name: "UsSsnRecognizer",
    category: "government_id",
    label: "US social security number",
    patterns: [{ name: "ssn", regex: US_SSN, score: 0.5 }],
    context: ["ssn", "social security", "taxpayer", "주민"],
    validate: (value) => (usSsnValid(value) ? { valid: true, score: 0.85 } : { valid: false, score: 0.35 }),
    weight: 45,
    redactable: true,
  },
  {
    entityType: "PERSON",
    name: "PersonRecognizer",
    category: "identity",
    label: "Named individual",
    patterns: [
      { name: "kr-name", regex: KR_NAME, score: 0.75, group: 1 },
      { name: "en-name", regex: EN_NAME, score: 0.8, group: 1 },
      { name: "en-title", regex: EN_TITLE_NAME, score: 0.6, group: 1 },
    ],
    context: ["성명", "이름", "환자", "의사", "담당", "name", "patient", "doctor", "signed"],
    weight: 26,
    redactable: true,
  },
  {
    entityType: "LOCATION",
    name: "LocationRecognizer",
    category: "contact",
    label: "Postal address",
    patterns: [
      { name: "kr-address", regex: KR_ADDRESS, score: 0.7 },
      { name: "en-address", regex: EN_ADDRESS, score: 0.65 },
    ],
    context: ["주소", "거주", "address", "residence", "lives at"],
    weight: 18,
    redactable: true,
  },
  {
    entityType: "IP_ADDRESS",
    name: "IpRecognizer",
    category: "contact",
    label: "IP address",
    patterns: [{ name: "ip", regex: IP, score: 0.6 }],
    context: ["ip", "address", "server", "host"],
    weight: 6,
    redactable: true,
  },
  {
    entityType: "URL",
    name: "UrlRecognizer",
    category: "contact",
    label: "URL",
    patterns: [{ name: "url", regex: URL, score: 0.3 }],
    context: ["url", "link", "site"],
    weight: 2,
    redactable: false,
  },
  {
    entityType: "DATE_TIME",
    name: "DateTimeRecognizer",
    category: "identity",
    label: "Date",
    patterns: [{ name: "date", regex: DATE, score: 0.3 }],
    context: ["date", "born", "dob", "생년월일", "날짜"],
    validate: (value) => {
      const [y, m, d] = value.split(/[-/.]/).map(Number);
      return dateValid(y, m, d) ? { valid: true } : { valid: false, score: 0.2 };
    },
    weight: 2,
    redactable: false,
  },
];

export const RECOGNIZER_BY_ENTITY = new Map<string, RecognizerDefinition>(
  RECOGNIZERS.map((recognizer) => [recognizer.entityType, recognizer]),
);
