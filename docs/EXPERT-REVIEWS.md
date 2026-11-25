# Three review rounds

**Status of these panels:** role-based internal reviews (rounds 1–4 review the 1.0/1.1 build; round 5 is the v1.2 re-audit). Each round applied a named professional lens — Firebase architect / Google Developer Expert, on-device (edge) AI engineer, Chrome extension UX lead, hackathon judge & product strategist — to this repository's design, source and docs. No external person was contacted, and the findings below are engineering reasoning, not quotations. Anything a round could not settle is listed as residual risk rather than assumed away.

---

## Round 1 — Which problem, which concept

*Question:* of the plausible #BuildHybridAI entries, which one is both winnable and genuinely useful, and which should be killed now?

Candidates scored on (a) does the hybrid split carry the value rather than decorate it, (b) is it demoable in 3 minutes without a special device, (c) can it be built and verified in the remaining days, (d) is the value proposition one sentence.

| Candidate | (a) | (b) | (c) | (d) | Verdict |
| --- | --- | --- | --- | --- | --- |
| Smart notes app that summarises offline | 2/5 | 5/5 | 5/5 | 3/5 | Killed: the hybrid split is invisible — any local summariser looks the same. |
| Voice/camera coach on Gemini Live | 2/5 | 2/5 | 2/5 | 3/5 | Killed: Live API is not hybrid inference, and the quota request is not guaranteed. |
| Local RAG over personal files | 3/5 | 3/5 | 2/5 | 3/5 | Killed: embeddings/retrieval add a second failure surface in the time available. |
| **Privacy-aware briefing desk (VaultBrief)** | **5/5** | **4/5** | **4/5** | **5/5** | **Selected.** |

**Architect:** the differentiator must be a *decision* the product makes that a cloud-only or device-only app structurally cannot make. "Which text may leave the device" is that decision, and it is the only place where `ONLY_ON_DEVICE` (which throws instead of falling back) is a feature rather than a limitation.

**Edge AI engineer:** the concept must survive a judge whose laptop has no Nano. Requiring the device in order to show value loses half the panel. → *change:* every flow has a documented second route (masked copy) and a visible "what you lost" explanation.

**Judge:** "summariser" reads as a demo, not a product. → *change:* the privacy receipt and the ledger became first-class UI, not a settings page.

**UX lead:** the user must see the decision *before* pressing the button, otherwise this is just another black box with better copy. → *change:* the routing console previews the selected `InferenceMode` on every keystroke.

---

## Round 2 — Hybrid architecture and runtime

*Questions:* is the SDK used the way the platform actually behaves? Where will this break in the judge's browser?

**Findings and what changed**

1. **`initializeDeviceModel` must run inside a user gesture.** A `useEffect` warm-up would look correct and fail silently on first use. → the call sits inside the click handler, with `downloadprogress` wired to the device panel; the panel also offers an explicit "Prepare on-device model" button for the minutes-long download.
2. **Generative models enforce replay protection.** Without `useLimitedUseAppCheckTokens: true` the call fails with `403 … must enforce Firebase App Check`, which is easy to misread as an App Check misconfiguration. → set on `getAI`, documented in troubleshooting.
3. **The mode you ask for is not the mode that ran.** `PREFER_ON_DEVICE` falls back silently when a download is in progress. Reporting our own intent as fact would make the receipt a lie. → the receipt reads `response.inferenceSource`, and a mismatch adds a visible "the SDK fell back" note.
4. **`ONLY_ON_DEVICE` throws, it does not fall back.** That is the correct primitive for the privacy guarantee, but it must never be selected when the model is not ready, or the user gets a dead button. → the router gates on a real `LanguageModel.availability()` probe, and returns a *blocked* plan (with instructions) instead of a request that will throw.
5. **Chunk budgets are asymmetric.** 1,800 characters on-device (quota-aware, from the Prompt API guidance) versus 12,000 in cloud; the device path needs an overlap, the cloud path must not double-count characters in the receipt. → separate budgets, and `cloudChars` counts document characters only, not prompt scaffolding.
6. **Masking must not destroy the document.** First implementation rewrote keyword matches ("patient", "diagnosis"), producing a brief about `[REDACTED:HEALTH]`. → signal rules were split from value rules; a named-person rule keeps its field label (`Patient: [REDACTED:IDENTITY]`); regression tests added.
7. **Error surfaces must be actionable.** A raw `PERMISSION_DENIED` tells a judge nothing. → `HybridError` maps App Check, key, quota and device-not-ready failures to a hint, and the UI shows it next to the failed run without discarding the plan.

**Judge:** a hosted demo without a project is worse than no demo. → demo mode exists, is loud about it (banner + `simulated` stamp on every receipt), and is described in the README as a *review mode*, not a result.

**Residual risk from this round:** none of steps 1–4 could be executed against a live project in this environment (no Firebase credentials, no Chrome with Nano). They are implemented from the current SDK typings and docs and checked by `scripts/verify-sdk-path.mjs` down to a real HTTP 400 from `firebasevertexai.googleapis.com`; the first live run must re-check App Check and the device download path.

---

## Round 3 — Adversarial review of the result, the demo and the criteria

*Questions:* if we were the judge, what would we mark down? What in the 3-minute video would look fake?

| Attack | Answer in the build |
| --- | --- |
| "This is a wrapper around the same prompt." | The router, the scan, the masking and the receipt are the product, and they are pure TypeScript with a test suite that runs on every push. `router.ts` contains the invariant no policy can bypass. |
| "Show me it's really on-device." | The receipt prints `inferenceSource`, the ledger sums characters that never reached the cloud, and the code path is one file. The video shows the same document routed three ways. |
| "Privacy claims are marketing." | Every claim is a counted number (characters, tokens, passes). The app refuses to run rather than softening a rule, and says which route it used when it had to change. |
| "The judge has no Gemini Nano." | The masked-copy route is the demo; the video shows both. The device panel states `availability` verbatim instead of pretending. |
| "Dollar figures are invented." | They are labelled estimates at a configurable list price, and the exact tokens are shown beside them. |
| "Korean documents?" | Included as a sample (국문 진단서) with Korean identifiers (주민등록번호, 휴대전화) and Korean health terms. |
| "Extension is untested." | Stated plainly in the README under "What is not claimed"; it is a side-panel shell around the app, so the AI path it exercises is the tested one. |

**UX lead:** the 3-minute cut must show the refusal, not just two success cases — that is the moment a judge remembers. → `docs/DEMO-SCRIPT.md` puts the refusal at 1:30 and the ledger at 1:55.

**Strategist:** the submission text has to answer "value proposition" in one sentence, and "how you used Firebase AI Logic" in code. → `docs/SUBMISSION.md` leads with the route table and the single call site.

**Decisions after this round**

1. Ledger promoted from a debug panel to a permanent column (it is the business case).
2. "Simulated" made impossible to miss on every receipt, at the cost of looking less polished in demo mode.
3. README restructured so a judge can reach the SDK code, the tests and the limits without scrolling.
4. Refusal path added as a first-class UI state with the reason and the remedy, rather than an error toast.

**Unresolved and honest**

- Live end-to-end verification (real project, real Nano, Firestore/Remote Config enabled) is still outstanding; everything up to the network boundary is verified.
- The extension has not been loaded in a real Chrome profile from this environment.
- The demo video and the public repository/hosting links do not exist yet; the script and the hosting configuration are ready.

---

## Round 4 — Line-by-line re-audit of the shipped build

*Question:* now that the product is finished, what does a sceptical reviewer find by reading every file with the tests running? This round was a full re-read of `src/`, `extension/`, the rules, the config and the docs, and every finding below was fixed and locked with a test or a check script.

| # | Defect found | Why it mattered | Fix |
| --- | --- | --- | --- |
| 1 | **Every Korean keyword rule was dead.** `/\b진단\b/` never matches: `\b` is defined on ASCII word characters, and a Hangul syllable is not one. Health, finance and legal Korean terms scored 0. | The app's Korean sample still scored 100 through its identifiers, which hid the bug; a Korean medical note without an ID would have been treated as public and sent to the cloud. | `keywordPattern()` keeps `\b` for English and matches Korean without it, allowing spacing to vary ("검사 결과" / "검사결과"). Tests cover 진단/처방/급여/비밀유지, and a keyword-only Korean note now reaches the threshold and is held back. |
| 2 | **A phone number was counted as a bank account.** The account pattern ran before the phone pattern and both match `010-2841-7734`; span de-duplication kept the earlier rule, so the scan reported a bank account (weight 32) and masked the phone as `[REDACTED:FINANCIAL]`. | Wrong category, inflated score, and a misleading label in the scan list. | Phone now runs first; the overlap rule is a real span test, not "same index and length", so an overlapping span is counted once. |
| 3 | **An overlap-only chunk could be summarised as content.** The splitter flushed the carried overlap as its own chunk when the next paragraph did not fit. | Wasted on-device passes and a brief that repeated a fragment. | The splitter tracks characters added since the last flush and never emits an overlap-only chunk; chunks are bounded by the budget, and the merge step is hierarchical (`groupForMerge`) so a merge prompt cannot overflow the on-device window. |
| 4 | **Remote Config's `cloud_model` never reached the SDK.** The value was read, stored and passed into `runBrief`, then ignored: the model object was built once from the default. | The README claimed model names were not hard-coded, and a judge changing Remote Config would see no effect. | `HybridClient.generate()` takes a per-call model name and caches model objects per (mode, model); the engine passes the effective name into every call, and the receipt records it. A test asserts the override reaches the client and appears in the receipt. |
| 5 | **No way to stop a long run, and no timeout.** A 34-pass on-device document (or a stalled cloud call) left the UI spinning with no exit. | The map-reduce path is the one place where the app can take minutes. | `runBrief` accepts an `AbortSignal`, checks it between passes, and the SDK call receives `{ signal, timeout: 90 s }`. A Stop button appears while running; a stopped run reports how far it got and writes no receipt. Aborts from the SDK are mapped to "stopped", not "failed". |
| 6 | **Demo mode invented dollar savings.** Simulated runs were counted in token and cost totals, so a judge with no project saw a "spend avoided" figure for runs in which no model was called. | Exactly the "dollar figures are invented" attack; it made the honest parts of the receipt less believable. | Metrics separate real from simulated runs; simulated runs are counted but excluded from tokens and dollars, and the KPI shows "—" with "simulated runs are not billed". |
| 7 | **`npm run typecheck` emitted JavaScript next to the sources** (`tsc -b --noEmit false`), and Vite then resolved `sensitivity.js` instead of `sensitivity.ts`. | Silent stale-code execution: the tests ran an older engine than the one on disk. | The script is `tsc --noEmit`; `.js`/`.tsbuildinfo` outputs are cleaned and ignored, and `npm run verify` runs typecheck, tests, build and the extension check in one go. |
| 8 | **The extension had no icons and could lose the first document.** `panel.js` posted into an iframe that might not have loaded yet, and the manifest declared no `icons`/`default_icon`. | Chrome shows a generic puzzle piece, and the first "Brief this page" press could do nothing. | Icons are generated by `scripts/make-icons.mjs` (PNG, 16/32/48/128); the panel queues the document until the iframe `load` event, times out with a framing hint, opens the app in a tab on request, and targets an explicit origin. `npm run verify:extension` checks all of it. |
| 9 | **Masked routes under-reported what stayed local and over-trusted placeholders.** `stayedLocalChars` was `input − transmitted`, which goes to 0 when placeholders are longer than the values they replace; a phone or address was reported as a generic contact. | The receipt could say "stayed local: 0" on a run that redacted six identifiers, and the `[REDACTED:...]` copy still revealed health or contract topics without saying so. | Masked runs report the characters actually replaced, add a note counting them, and the scan exposes `residual` topics; the router and receipt say what the masked copy still reveals. A document sensitive only by topic is blocked under Auto instead of being sent unmasked. |
| 10 | **Smaller gaps:** no guard for an empty document; `parseBrief` echoed JSON when the model returned a title only; the console hard-coded "threshold 40" while Remote Config could change it; ledger entries from the previous schema could break the maths; `parseFirebaseConfigPaste` rejected the `const firebaseConfig = {…}` shape it advertised; the App Check debug token was stored untrimmed. | Each is a small lie or a small crash in front of a judge. | All fixed with tests: empty text is refused, a title-only answer keeps its title, the threshold shown is the effective one, stored receipts are validated, both paste shapes parse, tokens are trimmed. |

**Residual risk after Round 4**

- No live project, no real Gemini Nano, no live Chrome profile in this environment: the network boundary and the MV3 contract are checked statically, not exercised. This remains the honest gap.
- The scan is pattern-based. It will miss identifiers written in an unusual shape and can over-flag unusual public text; that is why the router errs towards keeping text local and why the receipt reports what it did.
- The keyword lists are English + Korean only. A French or Japanese document gets value-rule coverage (numbers, emails, cards) but not topic coverage.

---

## Round 5 — v1.2 re-audit: what the seal changed

*Question:* the previous rounds fixed what a careful reader could see. What does a hostile
reader find now that the receipt is checkable and the invariant is stated as a guarantee?

| Attack | What it finds | Where it is answered |
| --- | --- | --- |
| "A public article with an email address goes to the cloud unmasked." | It did in 1.1. The gate was the 0–100 score. | The invariant is now identifier-level in `router.ts`, with a router test and an engine test (the public newsletter's footer address is masked). |
| "The receipt is a JSON blob you can edit." | It was. | Digest + ECDSA P-256 + document fingerprint + chain, verified in the app, by `scripts/verify-receipt.mjs` and by 16 tests including a spliced signature and a wrong document. |
| "Your signature proves nothing to a third party." | Correct, and now stated in the README and in this file: it is an issuing-key check, not attestation. What it does prove is that the file was not edited after sealing and that its chain neighbours exist. | `docs/DEEP-AUDIT-AND-UPGRADE.md` residual risks; README "Verifiable receipts". |
| "You never tested the SDK integration." | 14 tests against a fake SDK with the real surface, including App Check ordering and both device modes prepared; plus the contract check that reaches Google. | `hybrid.test.ts`, `scripts/verify-sdk-path.mjs`. |
| "Your Firestore mirror is decorative." | It was broken by the rules. | Rules updated for every mirrored field, `undefined` stripped, drift test parses the rules file. |
| "The side panel is fire-and-forget." | It was. | Versioned `hello`/`ready`/`receipt`, protocol check, origin+source checks, and static checks that the two constants stay in step. |
| "60,000 characters on every keystroke?" | 256 ms after the fix, 453 ms before, measured. | `perf.test.ts` prints and bounds it. |
| "No security headers." | True in 1.1. | `public/_headers` with an explicit CSP allowlist, checked by `verify:oss`. |

**Judge:** the new verify beat is the strongest 20 seconds in the video; keep it before the
cloud path so the first three minutes contain the claim *and* the proof.

**Residual risk after Round 5** — unchanged in kind from Round 4, reduced in size: no live
Firebase project, no real Nano/WebGPU in this environment; the signature is not third-party
attestation; pattern detection has the usual limits; the CSP allowlist must move with
Firebase's endpoints.
