# 3-minute demo video — shot list and voiceover

Target length 2:50. Everything must be visible on screen: the routing decision before the
run, the receipt after it, the seal it carries, and the refusal.

## Before recording

- Chrome 139+ desktop, `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → Enabled,
  restart, and press **Prepare on-device model** once so Gemini Nano is `available` (the
  download takes minutes and must not happen on camera).
- Firebase project connected (the green `LIVE · Firebase AI Logic` badge). Never record the
  demo-mode banner as if it were a model call.
- Ledger cleared, window 1512×900, zoom 100%, notifications off.
- Record 1440p, mouse movements slow, no scrolling thrash.

## Shots

**0:00–0:18 — The problem (talking head or title card over the app)**

> "Every AI summariser asks you to paste your document into a box and trust it. For a medical
> record or a contract, that's not a feature, it's a decision someone else made for you.
> This is VaultBrief: it makes that decision out loud, and hands you a receipt you can check."

**0:18–0:45 — Private document, on-device**

- Click the **Hospital discharge summary** chip.
- Point at the Sensitivity scan: `100/100`, Phone number, Date of birth, Email address,
  Medical record / licence number, Named individual, Health information.
- Point at the routing console: `◆ only_on_device` — "Sensitive document (100/100) → device-only inference."
- Press **Brief this document**. Brief appears in ~1s.

> "The scan runs locally — regular expressions and a Presidio-derived entity layer, no model.
> Thirteen matches, plus health terms and a named patient. Score one hundred, so the router
> picks device-only. Watch the receipt: ran on device, zero characters sent to the cloud."

**0:45–1:08 — Proof, not a promise (the new beat)**

- Press **Verify receipt** in the receipt block, then **Verify** in the drawer.
- Point at each line as it turns green: digest, signature, document fingerprint.
- Edit one digit of `cloudChars` in the JSON box, press **Verify** again: the digest line turns red.

> "This number is not what we asked for — it's what the SDK reports, `response.inferenceSource`.
> And the receipt is sealed: a SHA-256 digest, a fingerprint of this exact document, and an
> ECDSA signature from this browser's key. Verify it here, or in a terminal with the script in
> the repo. Change one character and the digest fails. That's the difference between a privacy
> claim and a privacy proof."

**1:08–1:30 — The cloud path, with a reason**

- Click **Public policy newsletter**, show the route flip to `☁ prefer_in_cloud · masked`.
- Press **Brief this document**; brief appears.

> "Public newsletter, four thousand characters, no health or contract terms — that's what the
> cloud model is good at. But it has a footer address, and the rule is about identifiers, not
> about the score: one email is masked before the copy leaves. Same code path, same call site,
> different inference mode. That's what a hybrid SDK is for."

**1:30–1:55 — The refusal (the memorable moment)**

- Click **Vendor NDA**. Keep **Mask identifiers before cloud** on: show the masked-copy route
  and the receipt `masked copy`.
- Then switch masking **off** and press **Brief this document**: red "not sent anywhere" panel.

> "Now the interesting one. This NDA is private and long. With masking on it's sent as a
> placeholder copy. Switch masking off and VaultBrief refuses to run at all. That rule lives in
> one function and no policy setting gets around it."

**1:55–2:15 — The ledger**

- Scroll to the ledger: device/cloud counts, characters kept local, cloud tokens avoided,
  estimated spend avoided.

> "Every run leaves a receipt in the ledger, chained to the one before it: on-device share,
> characters kept local, tokens that never consumed cloud quota. For a team handling client
> documents this is the number that matters — how much of the corpus never left the building."

**2:15–2:45 — How it's built (code on screen, 3 files)**

- `src/engine/hybrid.ts`: the single `getGenerativeModel` call with `mode`, `inCloudParams`,
  `onDeviceParams`, and `initializeDeviceModel` for both device modes.
- `src/engine/router.ts`: the identifier invariant.
- `src/engine/receipt.ts`: canonical body → digest → signature → chain.
- `npm test` output: 198 passed, 1 skipped.

> "One file touches Firebase AI Logic: App Check with limited-use tokens, device model
> initialisation inside the click, and the mode chosen by a router that's pure TypeScript.
> One-hundred-ninety-four tests, including an SDK contract check that really calls
> generateContent and a receipt verifier that runs outside the app."

**2:45–2:55 — Close**

> "On-device when it's private, cloud when it's public, masked when it's both — and a sealed
> receipt either way. VaultBrief: brief anything, keep what's private private."

## B-roll to capture while the app is warm

- The device panel showing `available` and the model download bar at 60%.
- The ledger after five runs, with the `sealed` row under each receipt.
- `evidence/receipt-sample.json` opened beside the terminal output of `npm run verify:receipt`:
  five green checks from a file the app did not have to be running to verify.

## What not to do

- Do not show the amber demo-mode banner while claiming a model ran.
- Do not speed up footage to hide a slow cloud call — a 2-second wait is honest.
- Do not exceed 3:00; judges only evaluate the first three minutes.
