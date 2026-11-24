# 3-minute demo video — shot list and voiceover

Target length 2:50. Everything must be visible on screen: the routing decision before the run, the receipt after it, and the refusal.

## Before recording

- Chrome 139+ desktop, `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → Enabled, restart, and press **Prepare on-device model** once so Gemini Nano is `available` (the download takes minutes and must not happen on camera).
- Firebase project connected (the green `LIVE · Firebase AI Logic` badge). Never record the demo-mode banner as if it were a model call.
- Ledger cleared, window 1512×900, zoom 100%, notifications off.
- Record 1440p, mouse movements slow, no scrolling thrash.

## Shots

**0:00–0:18 — The problem (talking head or title card over the app)**

> "Every AI summariser asks you to paste your document into a box and trust it. For a medical record or a contract, that's not a feature, it's a decision someone else made for you. This is VaultBrief: it makes that decision out loud, and shows its receipt."

**0:18–0:45 — Private document, on-device**

- Click the **Hospital discharge summary** chip.
- Point at the Sensitivity scan: `100/100`, Phone number, Date of birth, Email address, Medical record / licence number, Named individual, Health information.
- Point at the routing console: `◆ only_on_device` — "Sensitive document (100/100) → device-only inference."
- Press **Brief this document**. Brief appears in ~1s.

> "The scan runs locally — regular expressions, no model. Thirteen matches, six of them maskable identifiers, plus health terms and a named patient. Score one hundred, so the router picks device-only. Watch the receipt: ran on device, zero characters sent to the cloud."

**0:45–1:05 — Proof, not a promise**

- Zoom the receipt: `Ran on device · Sent to cloud 0 · Stayed local 1,482 · 1 pass`.
- Open the device monitor note under the brief: "Long documents are briefed map-reduce style in N passes that never leave the device."

> "This number is not what we asked for, it's what the SDK reports: `response.inferenceSource`. A long document is split into on-device passes and merged on the device, so a forty-page contract still never leaves the laptop."

**1:05–1:30 — The cloud path, with a reason**

- Click **Public policy newsletter**, show the route flip to `☁ prefer_in_cloud`.
- Press **Brief this document**; brief appears.

> "Public newsletter, four thousand characters, no identifiers — that's exactly what the cloud model is good at, so it goes to Gemini 3.5 Flash Lite. Same code path, same call site, different inference mode. That's the whole point of a hybrid SDK."

**1:30–1:55 — The refusal (the memorable moment)**

- Click **Vendor NDA**. Keep **Mask identifiers before cloud** on: show the masked-copy route and the receipt `masked copy`.
- Then switch masking **off** and press **Brief this document**: red "nothing was uploaded" panel.

> "Now the interesting one. This NDA is private and long. With masking on it's sent as a placeholder copy — `[REDACTED:CONTACT]` instead of an email address. Switch masking off and VaultBrief refuses to run at all. That rule lives in one place in the router and no policy setting can get around it."

**1:55–2:20 — The ledger**

- Scroll to the ledger: 3 device / 1 cloud, characters kept local, cloud tokens avoided, estimated spend avoided.

> "Every run leaves a receipt in the ledger: on-device share, characters kept local, tokens that never consumed cloud quota. For a team handling client documents this is the number that matters — not how fast the summary was, but how much of the corpus never left the building."

**2:20–2:45 — How it's built (code on screen, 2 files)**

- `src/engine/hybrid.ts`: the single `getGenerativeModel` call with `mode`, `inCloudParams`, `onDeviceParams`.
- `src/engine/router.ts`: the six-line invariant.
- `npm test` output: 88 passing.

> "One file touches Firebase AI Logic: App Check with limited-use tokens, device model initialisation inside the click handler, and the mode chosen by a router that's pure TypeScript and fully unit-tested. Forty-four tests, including an SDK contract check that really calls generateContent."

**2:45–2:55 — Close**

> "On-device when it's private, cloud when it's public, and a receipt either way. VaultBrief — brief anything, keep what's private private."

## B-roll to capture while the app is warm

- The device panel showing `available` and the model download bar at 60%.
- The `Rolling` ledger after five runs.
- `evidence/sdk-contract-check.json` showing the 400 from the fake key (proves the request is real).

## What not to do

- Do not show the amber demo-mode banner while claiming a model ran.
- Do not speed up footage to hide a slow cloud call — a 2-second wait is honest.
- Do not exceed 3:00; judges only evaluate the first three minutes.
