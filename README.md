# VaultBrief

**Brief anything. Keep what's private private.**

VaultBrief is a hybrid-AI briefing desk built for [#BuildHybridAI 2026](https://firebasehybridaihackathon.devpost.com/) with **Firebase AI Logic hybrid inference**: private documents are briefed by Gemini Nano **on your device**, public ones go to a cloud-hosted Gemini model, and every request leaves a **receipt** that states which one ran and exactly how many characters crossed the network boundary.

Most summarisers ask you to trust them with whatever you paste. VaultBrief decides *before* reading whether the text is allowed to leave the machine — a local scan, not a model, makes that call.

```
Medical record, NDA, payslip   →  Gemini Nano on-device  ·  0 characters sent
Public article, long report    →  Cloud Gemini           ·  long-form synthesis
Sensitive + no local model     →  masked copy only        ·  identifiers replaced
Sensitive + masking switched off →  refused               ·  nothing is uploaded
```

---

## Why hybrid

On-device models are fast, free and private, but they are not everywhere and they cannot hold a long document. Cloud models are capable and always available, but sending a patient record to one is a decision most people would refuse if they were asked.

VaultBrief makes that decision explicit and inspectable:

| Signal | Route | Why |
| --- | --- | --- |
| Sensitivity score ≥ 40 | `ONLY_ON_DEVICE` | Identifiers, health, finance, credentials, legal terms stay on the device, even if that means refusing to run. |
| Public and ≤ 2,600 chars | `PREFER_ON_DEVICE` | Free, instant, works offline; cloud only if the browser has no local model. |
| Public and > 2,600 chars | `PREFER_IN_CLOUD` | Long-form synthesis is what the cloud model is for. |
| Long and private | `ONLY_ON_DEVICE`, map-reduce | Chunked into on-device passes, then merged — still 0 characters sent. |
| Sensitive, no local model, masking on | `ONLY_IN_CLOUD` + redaction | Only a copy with `[REDACTED:CONTACT]`-style placeholders is transmitted. |
| Sensitive, no local model, masking off | **blocked** | The one invariant: identified text is never sent to the cloud. |

The three policies in the UI (`Auto`, `Device only`, `Cloud quality`) change the preference, never the invariant.

## What you see

- **Sensitivity scan** — 11 local rules (emails, phone numbers, Korean resident numbers, Luhn-checked card numbers, account numbers, passports, credentials, named individuals, health / finance / legal terms) scored 0–100. Runs on every keystroke, never touches the network.
- **Routing decision** — the exact `InferenceMode` that will be used and a sentence explaining why, before you press anything.
- **Brief** — title, TL;DR, key points and flags, produced as strict JSON by either model.
- **Privacy receipt** — where it actually ran (from `response.inferenceSource`, not from what we asked for), latency, chunks, characters sent vs. kept, tokens, and any fallback that occurred.
- **Ledger** — every run for this browser: on-device share, characters kept local, cloud tokens avoided, estimated spend avoided.

## How Firebase AI Logic is used

One model object, one call site, and the SDK decides where the prompt runs (`src/engine/hybrid.ts`):

```ts
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";

const ai = getAI(firebaseApp, {
  backend: new GoogleAIBackend(),
  useLimitedUseAppCheckTokens: true,   // generative models enforce replay protection
});

const model = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,
  inCloudParams: {
    model: "gemini-3.5-flash-lite",
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: BRIEF_SCHEMA },
  },
  onDeviceParams: {
    createOptions: {
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    },
  },
});

// inside a click handler: Chrome only downloads the model with user activation
await model.initializeDeviceModel((progress) => setDownloadProgress(progress));

const result = await model.generateContent(prompt);
const source = result.response.inferenceSource; // "on_device" | "in_cloud"
```

| File | Role |
| --- | --- |
| `src/engine/hybrid.ts` | The only file that imports `firebase/ai`. App Check debug/provider setup, mode mapping, `initializeDeviceModel`, error translation. |
| `src/engine/router.ts` | Decides the inference mode from sensitivity + length + device state; enforces the masking invariant. |
| `src/engine/sensitivity.ts` | Local scan and redaction. No network, no model. |
| `src/engine/engine.ts` | Orchestration: scan → route → mask → chunk → generate → merge → receipt. |
| `src/engine/device.ts` | Read-only `LanguageModel.availability()` probe for the capability panel. |
| `src/engine/remote.ts` | Remote Config overrides (`sensitivity_threshold`, `cloud_model`) — model names are not hard-coded. |
| `src/engine/store.ts` | Ledger persistence (localStorage) and fire-and-forget Firestore mirroring. |

### Firebase products

| Product | Where | Notes |
| --- | --- | --- |
| **AI Logic (hybrid)** | `src/engine/hybrid.ts` | Required runtime path: imported and called on every brief. |
| **App Check** | `src/engine/hybrid.ts` | Enforced for AI Logic. reCAPTCHA Enterprise in production, registered debug token for review builds (the hackathon accepts debug tokens). |
| **Remote Config** | `src/engine/remote.ts` | Sensitivity threshold and model name, fetched on connect. |
| **Firestore** | `src/engine/store.ts` + `firestore.rules` | Optional: mirrors receipts under the anonymous user's own document. |
| **Authentication** | `src/engine/store.ts` | Optional anonymous sign-in, only for the Firestore mirror. |

## Run it

```bash
npm install
cp .env.example .env.local      # add your Firebase web config + App Check
npm run dev                     # http://localhost:5173
npm test                        # 44 unit + UI tests
npm run build                   # static build in dist/
```

Without a Firebase config the app starts in **demo mode**: the banner says so, every receipt is stamped `simulated`, and briefs come from a local extractive summariser. That mode exists so the routing, masking and receipt logic can be reviewed end to end — it is never presented as a model call.

With no on-device model (any non-Chrome browser, or Chrome without the Prompt API flag), the app still works: private documents take the masked-cloud route, or are refused. See [docs/SETUP-FIREBASE.md](docs/SETUP-FIREBASE.md) for the project, AI Logic provisioning (`npx firebase-tools init ailogic`), App Check and hosting steps.

### On-device requirements

Chrome 139+ on desktop with `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` set to *Enabled*. The first request (or the “Prepare on-device model” button) downloads Gemini Nano; progress is shown in the device panel.

## Tests and evidence

```bash
npm test                       # 44 passing: scan/redact, routing, chunking, JSON parsing,
                               # ledger maths, and a jsdom UI run of the whole screen
node scripts/verify-sdk-path.mjs
```

`scripts/verify-sdk-path.mjs` checks the real SDK without any project. It confirms the exported `InferenceMode` values match the router, builds a model from exactly the parameters above, and calls `generateContent()` — which reaches Google and fails only on the deliberately fake key. Saved output: [`evidence/sdk-contract-check.json`](evidence/sdk-contract-check.json).

```
"generateContent": {
  "latencyMs": 491,
  "error": { "code": "fetch-error",
    "message": "AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/
                vaultbrief-contract-check/models/gemini-3.5-flash-lite:generateContent:
                [400 Bad Request] API key not valid." }
}
```

## Chrome extension

`extension/` is an MV3 side panel: it extracts the readable text of the current tab and hands it to the running app in an iframe, so the AI work still happens on the app's https origin with App Check intact. Load it unpacked from `chrome://extensions`, open the side panel, set the App URL, press *Brief this page*.

## What is not claimed

- No PDF or Word parser: the app reads pasted text and plain-text files. A scanned PDF is not read.
- The dollar figure is an estimate from a configurable list price (`src/engine/metrics.ts`), not a bill; the exact numbers are the token counts.
- The demo-mode simulator is an extractive summariser, not a model.
- The extension is a shell around the hosted app and has not been run against a live profile in this repository's test suite.

## License

Apache 2.0 — see [LICENSE](LICENSE).
