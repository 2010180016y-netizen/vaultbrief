# Open-source research and what we took from it

Everything below was cloned or installed into this workspace during the build (`vendor/`, `node_modules/`), read, and used. The "what we changed" column is the part that matters — nothing was copied whole.

## Installed and analysed

| Source | How it was obtained | What it does | What we took |
| --- | --- | --- | --- |
| [`firebase/agent-skills`](https://github.com/firebase/agent-skills) (Apache-2.0) | `git clone --depth 1` → `vendor/agent-skills` | Official Agent Skills: `firebase-ai-logic-basics`, `firebase-basics`, `firebase-hosting-basics`, `firebase-firestore`, `firebase-remote-config-basics`, `firebase-security-rules-auditor`. | App Check is **mandatory** for AI Logic and must be set up before any call; a debug token must be injected through env/CI, never committed (we read it from `VITE_APPCHECK_DEBUG_TOKEN` / the Settings drawer). `init ailogic` is a required provisioning step in our setup doc. Model names must not be hard-coded → Remote Config (`sensitivity_threshold`, `cloud_model`). |
| [`webmachinelearning/prompt-api`](https://github.com/webmachinelearning/prompt-api) (W3C spec, W3C-CLA) | `git clone --depth 1` → `vendor/prompt-api` | The Prompt API specification: `LanguageModel.availability()`, `create()` options, `expectedInputs`/`expectedOutputs`, `monitor`/`downloadprogress`, `measureInputUsage`/`inputQuota`, `samplingMode` presets. | Our capability probe calls `availability()` with the **same options** we pass to `onDeviceParams.createOptions` (the docs stress that mismatch gives wrong answers). `downloadprogress` drives the download bar. `inputQuota` is what justifies the 1,800-character on-device chunk budget. |
| [`GoogleChromeLabs/web-ai-demos`](https://github.com/GoogleChromeLabs/web-ai-demos) (Apache-2.0) | sparse clone → `vendor/web-ai-demos/{summary-of-summaries,prompt-api-playground}` | `summary-of-summaries` solves the context-window problem with `RecursiveCharacterTextSplitter` + recursive merge over `inputQuota`; `prompt-api-playground` shows capability UI patterns. | The map-reduce shape (chunk → summarise each → merge → merge again) is ours but modelled on it. We replaced LangChain's splitter with a dependency-free paragraph/sentence splitter (our `chunk.ts`, 7 unit tests) because a 40 kB dependency for one function is not worth it. Their `waitForUserActivation()` helper confirmed why our brief must start from a click. |
| [`firebase/firebase-js-sdk`](https://github.com/firebase/firebase-js-sdk) (`@firebase/ai` 13.4.0) | `npm install firebase` | The hybrid API itself. | We read the shipped `.d.ts` rather than only the docs: `HybridParams { mode, onDeviceParams, inCloudParams }`, `InferenceMode`/`InferenceSource` value strings, `GenerateContentResponse.inferenceSource`, and that `generationConfig.responseJsonSchema` accepts plain JSON Schema. `scripts/verify-sdk-path.mjs` asserts the value strings match our router. |
| [`@types/dom-chromium-ai`](https://www.npmjs.com/package/@types/dom-chromium-ai) | `npm install -D` | TypeScript types for Chrome's built-in AI APIs. | Typed probe without `any` (the vendored demos use `declare global { interface Window { … any } }`). |
| [Firebase AI Logic hybrid docs](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started) + [configuration options](https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options) + [the hybrid blog post](https://firebase.blog/posts/2025/10/understand-ai-logic-hybrid-inference/) | web | Fallback semantics per mode, `initializeDeviceModel` rules, `inferenceSource`. | Our mode table: `ONLY_ON_DEVICE` throws instead of falling back (used as the privacy guarantee), `PREFER_ON_DEVICE`/`PREFER_IN_CLOUD` tolerate a download in progress, and the receipt reads `inferenceSource` instead of trusting the request. The blog's "short sentence on-device, long sentence in cloud" router is the seed of `router.ts`. |

## What we deliberately did not take

- **LangChain `@langchain/textsplitters`** — a 40 kB dependency (plus its tree) for one splitter; our version is 60 lines and tested.
- **`window.LanguageModel` direct prompting** — the vendored demos prompt the model directly. The hackathon requires AI Logic to run the inference, so our only direct use of the platform API is a read-only `availability()` probe; all inference goes through `firebase/ai`.
- **Vendored demo styling** — their UI is a playground, ours is a privacy console.

## Resulting design decisions

1. **The router is pure TypeScript.** No model decides routing; a model that needs the network cannot answer "may this text use the network?".
2. **Two rule kinds.** `sensitivity.ts` separates *signal* rules (keywords: raise the score, never rewritten) from *value* rules (emails, numbers, names: rewritten). The first build redacted the word "patient" inside a medical record; the split fixed it and a test locks it in.
3. **Quota-aware chunking.** 1,800 characters on-device, 12,000 in cloud, with a 120-character overlap only on the device path.
4. **One invariant, one place.** `router.ts` is the only module that can let text reach the cloud, and it refuses when the text is sensitive and masking is off.
5. **Honest fallbacks.** Missing project → demo mode with a stamped receipt; missing model → documented route change, never a silent upload.
