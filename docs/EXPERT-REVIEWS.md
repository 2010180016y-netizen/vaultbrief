# Three review rounds

**Status of these panels:** role-based internal reviews. Each round applied a named professional lens — Firebase architect / Google Developer Expert, on-device (edge) AI engineer, Chrome extension UX lead, hackathon judge & product strategist — to this repository's design, source and docs. No external person was contacted, and the findings below are engineering reasoning, not quotations. Anything a round could not settle is listed as residual risk rather than assumed away.

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
| "This is a wrapper around the same prompt." | The router, the scan, the masking and the receipt are the product, and they are pure TypeScript with 44 tests. `router.ts` contains the invariant no policy can bypass. |
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
