# VaultBrief — seven-step deep audit and award-level upgrade

**Scope:** every file of `competitions/buildhybridai-2026/` — the React app (`src/`), the
Chrome MV3 side panel (`extension/`), the Firebase wiring, the three local engines
(Gemini Nano / WebLLM / transformers.js), the Presidio port, the tests, the build and
deploy scripts, the security rules and every document.
**Version audited:** 1.1.0 (commit `08c8415`) → **shipped:** 1.2.0.
**Method:** read every source file end to end, run the whole pipeline, then attack it as
a judge and as a security reviewer would. Every finding below has a reproduction, a
severity, a fix and a test that keeps the fix honest.

---

## Step 1 — What actually exists (inventory)

| Area | Files | Lines | What it does |
| --- | --- | --- | --- |
| Screen | `src/App.tsx`, `src/components/*` (6), `src/styles.css` | ~2,100 | Four panels: document, brief + receipt, privacy console, device/settings. |
| Engine | `src/engine/*.ts` (21), `presidio/*` (5) | ~4,300 | Scan → route → mask → chunk → generate → merge → receipt. |
| Extension | `extension/*` | ~330 | MV3 side panel + iframe bridge. |
| Verification | `src/**/*.test.ts(x)` (19), `scripts/*.mjs`, `scripts/*.py` | ~3,600 | 199 tests, 3 static contract checks, a Presidio oracle. |
| Docs | `README.md`, `docs/*` (5) | ~1,300 | Setup, submission, demo script, reviews, OSS research. |
| Firebase | `firebase.json`, `firestore.rules`, `remoteconfig.template.json` | ~120 | Hosting, receipt rules, two Remote Config parameters. |

Runtime structure as it was: one `firebase/ai` call site (`hybrid.ts`), a pure-TypeScript
router, three local detectors (rules, Presidio entities, embeddings), and a receipt built
from `response.inferenceSource` and character counts. The architecture claim was honest;
several of the guarantees around it were not yet true. That is what this audit found.

---

## Step 2 — Adversarial findings

Severity: **C**ritical (breaks the product's own guarantee), **H**igh (silently wrong or a
dead end for a judge), **M**edium (cost, coverage, honesty), **L**ow (polish).

| # | Sev | Area | Finding (with reproduction) | Why it mattered |
| --- | --- | --- | --- | --- |
| 1 | **C** | Privacy invariant | The masking gate was the score: `redactBeforeSending` was only set when `score ≥ 40`. A public newsletter (14/100) with `letters@thegridletter.example` went to the cloud **unmasked**, although README, submission and UI all said identifiers never leave unmasked. | The headline claim was false for exactly the documents people are most likely to paste. |
| 2 | **C** | Receipt integrity | Receipts were plain objects in `localStorage`. `loadLedger` only type-checks them; nothing binds a receipt to its document, its issuer or its neighbours, and no UI or CLI could verify one. The brief's "receipt verification" was missing entirely. | A receipt nobody can check is decoration. The privacy claim rested on a number the app itself could edit. |
| 3 | **H** | Hybrid inference | `prepareDevice()` initialised only the `prefer_on_device` model object. `ONLY_ON_DEVICE` — the mode the router chooses for every private document — is a *different* model object in the SDK and was never initialised. | The first private document on a fresh Chrome could fail with “model not ready” after the user had already waited for the download. |
| 4 | **H** | Routing vs. device state | `handleRun` prepared Nano inside the click, then passed the **stale** `device` (still `downloadable`) to `runBrief`. The router therefore blocked the private document on a machine that had just become capable. | A dead end in the most important demo path: press Brief, watch the model download, get “no on-device model”. |
| 5 | **H** | Firestore mirror | `firestore.rules` allowed only the 1.0 receipt keys. Every real receipt now carries `pii`, `semantic`, `local`, and the rules rejected the write; `semantic: undefined` would also make the SDK throw. The failure was swallowed as “optional”. | The optional mirror had been silently dead since the Presidio release. |
| 6 | **H** | Extension | The panel posted a document into the iframe and claimed “N characters handed to the app” unconditionally. No acknowledgement, no receipt, no protocol version; any `chrome-extension://` origin could hand text to the app, and nothing came back. | “확장–웹앱 동기화” was one-way and unverifiable, and the panel could lie to its user. |
| 7 | **M** | Route accounting | `actualSource` was assigned per pass, so a mixed run (some chunks device, some cloud) reported only the **last** pass, and the fallback note compared that single value to the plan. | A receipt that misreports where a run happened is worse than no receipt. |
| 8 | **M** | Performance | Every keystroke ran `scan(text)`, `analyzeDocument(text)` and `maskDocument(text)` (which analyses again). Measured on 60,000 characters: 453 ms of duplicated work vs 256 ms for one pass (1.77×). | Typing in a long document janked for no reason. |
| 9 | **M** | Korean coverage | Names were recognised only after a field label. `김민수 씨`, `이지훈 과장` — the normal Korean ways to name a person — were invisible. | A Korean note without labels could score below the threshold while naming patients. |
| 10 | **M** | Honesty of docs | Four different test counts across README (140), submission (141), demo script (88, “forty-four”), expert reviews (92). The public route was described as “no identifiers”. | A judge who checks one number stops trusting the rest. |
| 11 | **M** | Transport | No security headers at all: no CSP, no `nosniff`, no referrer policy, no framing policy. | For a product whose argument is “your document stays here”, that is a visible gap. |
| 12 | **L** | UI | `embedderStatus` initialised with `embeddings ? "off" : "off"`; the passport rule used `[MS]` while the Presidio layer used `[MSROD]`; `mergeScans` mutated the caller's detections. | Dead code and two layers that disagree invite the next bug. |
| 13 | **L** | Test blind spots | `hybrid.ts` (App Check, model caching, device preparation), `bridge`, receipt integrity, the Firestore/rules contract and the per-keystroke cost had no tests. | The parts a judge cannot run by hand were exactly the untested ones. |
| 14 | **M** | Dependencies | `npm audit` showed 4 high advisories via the transitive `@grpc/grpc-js@1.9.16` (Firestore's Node transport). | A public privacy repo with open high advisories invites the question of how carefully it is maintained. |

---

## Step 3 — Strategy

The judge scores four things. Each finding was assigned to one of them, and every change
had to move a number or close a demonstrated hole — no cosmetic work.

| Criterion | What a winning entry must show | Strategy chosen |
| --- | --- | --- |
| **Hybrid AI 활용도** | That the on-device/cloud split is the product, not a decoration; that the SDK's real semantics are respected. | Fix the device-preparation model-object bug; route on the *post-preparation* device; report the route per pass; keep one call site and all four `InferenceMode` values in use. |
| **프라이버시 보증** | A guarantee that survives an adversarial reader. | Make the invariant identifier-level (finding 1); make the receipt cryptographically checkable (2); make the mirror match its rules (5); add transport headers (11). |
| **완성도** | No dead ends, no silent failures, no contradictory docs. | Surface preparation failures; two-way extension handshake with protocol check; single-pass preview (8); Korean names (9); one set of numbers in every document (10); tests for every seam (13). |
| **데모 임팩트** | A 20-second moment a judge remembers. | The **Verify receipt** button: press it after a run and watch digest, signature, document fingerprint and chain pass one by one — then edit one character and watch it fail. The identifier-masked public newsletter is the second moment. |

Deliberately rejected: adding a PDF parser, a chat follow-up, a settings page for the
signing key, or a “team policy” UI. None of them strengthens the four criteria in the time
available, and each adds a failure surface to an app whose value is that it refuses.
The receipt signature is explicitly **not** sold as third-party attestation — it is an
issuing-key check plus chain, and the docs say so.

---

## Step 4 — Process (implementation order and gates)

Order was chosen so that every step left the repo green:

1. **Foundations first** — `hash.ts` (SHA-256, canonical JSON) with known-answer tests, so
   everything after it could rely on a byte-identical serialisation.
2. **Receipt sealing** — `types.ts` → `receipt.ts` → `engine.ts` seal → CLI
   (`scripts/verify-receipt.mjs`) → tests, including the CLI round-trip, so the browser and
   the terminal were proven to agree before any UI existed.
3. **Invariant** — `router.ts` rewritten around `scan.redactable`, with the three refusal
   and masking paths covered; existing router tests kept and extended.
4. **Hybrid client** — loader injection, both device modes prepared, lazy fallback,
   per-call model cache; 14 tests against a fake SDK with the real surface.
5. **Bridge** — `bridge.ts` contract + tests, then App and `panel.js` on both sides, then
   `verify-extension` checks that the two protocol constants still match.
6. **Screen** — single analysis pass, post-preparation device, verifier panel, seal row in
   the receipt, ledger “verify”.
7. **Delivery** — Firestore rules + mirror payload + drift test; `public/_headers` +
   checks; version bump; docs.

Gates at every step: `npm run typecheck` → the affected test file → `npm test` → build.
Nothing was committed until all four were green.

File-level change set (23 modified, 10 added):

```
src/engine/hash.ts            new   SHA-256 + canonical JSON (no dependency)
src/engine/receipt.ts         new   seal, verify, parse, export
src/engine/bridge.ts          new   hello/ready/receipt contract
src/components/ReceiptVerifier.tsx new  the verifier drawer
src/engine/router.ts          rewrite of decideRoute around identifiers
src/engine/hybrid.ts          both device modes prepared, loader seam
src/engine/engine.ts          aggregated source, split, seal, chain input
src/engine/store.ts           Firestore-safe mirror payload
src/engine/types.ts           ReceiptIntegrity, split, integrity
src/engine/presidio/recognizers.ts  Korean honorific names + stoplist
src/engine/sensitivity.ts     passport prefixes aligned with the entity layer
src/App.tsx                   single analysis, fresh device, chain, bridge replies
src/components/{BriefPanel,ConsolePanel}.tsx  seal row + verify entry
src/styles.css                verifier and seal styles
firestore.rules               every mirrored field, bounded
public/_headers               CSP + transport headers
extension/{panel.js,panel.html,manifest.json}  handshake, receipt line, 1.2.0
scripts/verify-receipt.mjs    new   independent verifier
scripts/verify-{oss,extension}.mjs  header + protocol checks
9 test files added or extended
```

---

## Step 5 — What was implemented

**1. Identifier-level invariant (finding 1).** `decideRoute` now computes
`identifiers = scan.redactable` and applies it to *every* path that can reach the cloud:
`PREFER_IN_CLOUD`, `PREFER_ON_DEVICE`'s cloud fallback, `ONLY_IN_CLOUD`, and
`Cloud quality`. With masking on, the masked copy is sent; with masking off, the run is
refused with the remedy. The score keeps deciding sensitivity (device-only, or refusal when
nothing is maskable), so the two questions — “is this private?” and “does this carry an
identifier?” — are answered separately.

**2. Verifiable receipts (finding 2).** Canonical JSON (sorted keys, no whitespace) →
SHA-256 digest → ECDSA P-256 signature with a per-browser key stored as a JWK, public key
travelling in the receipt → `documentSha256` binding → `prev`/`seq` chain. The signed body
includes the chain link and the document fingerprint, so neither can be swapped without
breaking the signature. Verification runs in three places: the app (`ReceiptVerifier`),
`scripts/verify-receipt.mjs`, and the tests. Internal consistency checks (a device run
cannot have sent cloud characters; unmasked counts must add up) catch a receipt that was
*signed by us* but describes an impossible run.

**3. Device preparation (finding 3, 4).** `prepareDevice()` initialises `prefer_on_device`
**and** `only_on_device`; `generate()` makes one lazy attempt for a device mode that was
never prepared (fast when the model is installed) and translates the failure otherwise.
`handleRun` re-probes the runtime after preparation and routes on the fresh status.

**4. Route accounting (finding 7).** Every pass (document and merge) contributes to a
`seenSources` set; the receipt's `source` is `in_cloud` if **any** pass reached the cloud,
and `split: { onDevicePasses, cloudPasses }` exposes the mix. The UI shows the split only
when both sides ran.

**5. Firestore mirror (finding 5).** `RECEIPT_MIRROR_FIELDS` + `mirrorPayload()` produce a
JSON-round-tripped payload with no `undefined`; `firestore.rules` allows exactly those keys
with per-field type and size limits, and optional blocks are validated only when present. A
test parses the rules file and fails if the app writes a key the rules reject.

**6. Extension handshake (finding 6).** `hello`/`ready`/`receipt` with `BRIDGE_PROTOCOL = 2`.
The panel unlocks the grab button only after a protocol match, accepts messages only from
its own iframe and origin, and shows `on-device · 0 characters sent · sealed signed …` after
the run. The app accepts documents only from its own origin or `chrome-extension://`, and
replies with `postMessage(payload, event.origin)` — never `"*"`.

**7. Performance (finding 8).** One `useMemo` produces `{ ruleScan, masked, pii }`;
`maskDocument`'s analysis is reused for the Presidio panel and the router. Measured:
60,000 characters **255.6 ms** (single pass) vs **452.7 ms** (the old duplicated work),
1.77×; the Korean sample (1,868 characters) 1.6 ms. `perf.test.ts` locks the budget.

**8. Korean names (finding 9).** A `kr-honorific` pattern recognises `이름 + 씨/님/과장/…`
followed by a particle or punctuation, with a 19-word stoplist (`고객`, `회원`, `담당`, …) so
polite nouns are not turned into people. Tested both ways.

**9. Dependency advisories (finding 14, found while checking the delivered state).** `npm audit`
reported four high advisories, all through `@grpc/grpc-js@1.9.16` (pulled in by Firestore's Node
transport; not part of the browser bundle). `overrides` now pins `@grpc/grpc-js@^1.14.7`;
`npm audit` reports **0 vulnerabilities** and the suite, build and contract checks are unchanged.

**10. Honesty and delivery (findings 10–13).** Every document now states 199 tests (198
offline + 1 opt-in), and the public route is described as “identifiers masked”. `public/_headers`
ships CSP/`nosniff`/referrer/permissions/framing policy, checked by `verify:oss`. Dead code
removed; passport prefixes aligned; `mergeScans` no longer mutates its input. New tests
added for the hybrid client (14), the receipt (16), the bridge (6) and the preview cost (2).

---

## Step 6 — Strategy check (criterion → artifact)

| Criterion | Evidence in the build | Status |
| --- | --- | --- |
| Hybrid AI 활용도 | All four `InferenceMode` values used and mapped 1:1 to router modes; one `getGenerativeModel` call site; both device modes prepared inside the gesture; per-pass route in the receipt; WebLLM serves the route where Nano is absent. Tests: `hybrid.test.ts` (14), `integration.test.ts` (9). | Met. The remaining gap is a real GPU/Nano, which this environment does not have and the README states. |
| 프라이버시 보증 | Identifier-level invariant with 19 router tests; masking before any cloud call; refusal paths with remedies; sealed receipt (digest, signature, document binding, chain) with 16 tests and an independent CLI; Firestore rules aligned by test; CSP allowlist. | Met, with the documented limit that the signature is not third-party attestation. |
| 완성도 | 199 tests green; typecheck/build/extension/receipt/OSS checks green; no swallowed preparation error; no dead end when Nano is downloadable; protocol-checked extension; one set of numbers in the docs; perf budget measured. | Met. |
| 데모 임팩트 | New 20-second beat: run → **Verify receipt** → five checks pass; edit a field → digest fails. Second beat: the public newsletter with its address masked before the cloud call. `docs/DEMO-SCRIPT.md` updated to put both on screen. | Met; the shot list is updated, the recording itself is out of scope for this task. |

Gaps found during the check and closed immediately: (a) the verifier initially could not
check the chain link because the drawer received no previous digest — now passed from the
ledger; (b) `Cloud quality` with masking off and identifiers present was still allowed —
now refused; (c) the Firestore payload included `undefined` fields — now sanitised and
tested.

---

## Step 7 — Verification and running state

### Local gates (this workspace, Node 22.23.5)

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean (`tsc --noEmit`, strict, `noUnusedLocals`) |
| `npm test` | **198 passed, 1 skipped (199)**, 19 files, 0 failed |
| `npm run build` | built in ~3 s; `index-*.js` 345 kB (gzip 113 kB); WebLLM (6.1 MB) and transformers.js stay in lazy chunks |
| `npm run verify:extension` | **9/9** checks, including the panel↔app protocol match |
| `npm run verify:receipt` | **5/5** checks on the committed sample (`VERIFIED`) |
| `npm run verify:oss` | **26/26** checks (dependencies, API surface, corpus, headers) |
| `npm audit` | **0 vulnerabilities** (after the `@grpc/grpc-js` override) |
| `node scripts/verify-sdk-path.mjs` | real SDK contract: 4 modes, parameters accepted, request reaches `firebasevertexai.googleapis.com` and fails only on the fake key |

Baseline before this round, measured the same way: 143 passed + 1 skipped (144), 6 extension checks and 21 OSS checks; after the first pass of this audit 193+1 (194), and 198+1 (199) once the identifier-invariant tests were added.

### Receipt verification, independently

```
$ npm run verify:receipt
receipt: evidence/receipt-sample.json
PASS  integrity block       v2 · ECDSA-P256-SHA256 · seq 7
PASS  digest                sha256 8960d51be6545617ad76f5d00b83f4c2…
PASS  signature             ECDSA P-256 valid · key f5195b8ca95bfc98
PASS  document fingerprint  sha256 a505d4dabcde46c7557263c4c795c844… matches receipt-sample-document.txt
PASS  ledger chain          follows bbbbbbbbbbbbbbbb…
VERIFIED — 5/5 checks passed
```

### Continuous integration

`.github/workflows/verify.yml` is unchanged (the GitHub App token has no `workflows`
scope), and `npm test` still runs the OSS contract, so CI exercises the same gates:
typecheck → tests → build → extension contract → icon reproducibility. The new receipt
verification is part of `npm run verify`; a run of it is recorded with the push.

### Live deployment

`https://vaultbrief-bby.pages.dev` — deployed from `dist/` after the upgrade; the browser
check, screenshots and the exact button path are recorded in the report that accompanies
this document (files `evidence/live-pages-v1-2-*.png`).

---

## Residual risks (stated, not hidden)

1. **No live Firebase project, no Gemini Nano, no WebGPU in this environment.** Everything
   up to the network boundary is verified; the SDK contract check reaches Google's endpoint.
   The first live run must re-check App Check and the device download path.
2. **The receipt signature is an issuing-key check, not a certificate.** It proves the
   receipt was not edited after sealing; a forger mints a new key and shows a new `keyId`.
3. **The CSP allowlist is explicit.** If Firebase or Hugging Face add an origin, the app
   fails closed (requests blocked) rather than open; the list is in one file.
4. **Pattern-based detection has limits.** Unusual formats are missed, unusual public text
   can be over-flagged. The router errs toward keeping text local, and the receipt reports
   what it did.
5. **The extension is verified statically**, not by loading it into a live Chrome profile
   from this environment; its protocol, markup, CSP constraints and permissions are checked.
6. **Losing site data loses the receipt key.** Old receipts still verify individually, but
   the chain starts a new `keyId`.
