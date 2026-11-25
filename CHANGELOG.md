# Changelog

## 1.2.0 — 2026-11-25

A seven-step audit and upgrade of the #BuildHybridAI entry. The full record, with findings,
severities, strategy and measured evidence, is in
[docs/DEEP-AUDIT-AND-UPGRADE.md](docs/DEEP-AUDIT-AND-UPGRADE.md).

### Privacy guarantee

- **Breaking (in the user's favour): the masking rule is now about identifiers, not the
  score.** Any document carrying a maskable identifier is masked before *any* cloud call,
  including public documents whose score stays below the threshold. With masking switched
  off, such a run is refused with the remedy. The 0–100 score still decides sensitivity.
- The masked public route reports what was replaced in the router, the receipt and the
  console.

### Verifiable receipts

- New `src/engine/receipt.ts`: canonical JSON → SHA-256 digest → ECDSA P-256 signature
  (per-browser key, public key carried in the receipt) → `documentSha256` binding →
  `prev`/`seq` chain.
- New `src/engine/hash.ts`: dependency-free SHA-256 and canonical JSON, checked against
  `node:crypto` and the NIST vectors.
- New in-app **Verify receipt** drawer: digest, signature, document fingerprint, chain and
  internal consistency, each with its result.
- New `scripts/verify-receipt.mjs` and `npm run verify:receipt`, with a committed sample
  (`evidence/receipt-sample.json`) that verifies 5/5 outside the app.

### Hybrid inference

- Both on-device models (`PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`) are initialised inside the
  user gesture; a device mode that was never prepared gets one lazy attempt.
- The router sees the device state **after** preparation, not before.
- The receipt aggregates the source over every pass and exposes
  `split: { onDevicePasses, cloudPasses }`.

### Extension

- Versioned `hello`/`ready`/`receipt` bridge (`src/engine/bridge.ts`), protocol check,
  origin+source checks on both sides, receipt summary in the panel.
- Manifest 1.2.0, new static checks in `verify:extension`.

### Correctness and cost

- Firestore rules accept every field the app mirrors, with bounds; the mirror payload drops
  `undefined`; a test parses the rules file so the two cannot drift.
- One analysis per edit instead of four: 60,000 characters 256 ms instead of 453 ms.
- Korean names after an honorific or job title, with a stoplist; passport prefixes aligned
  between the two layers; dead code removed.

### Dependencies

- `overrides` pins `@grpc/grpc-js@^1.14.7` (Firestore's Node transport, not in the browser
  bundle): `npm audit` is now clean (was 4 high advisories).

### Delivery

- `public/_headers`: CSP allowlist, `nosniff`, referrer policy, permissions policy, framing
  policy (the side panel may frame the app; nobody else).
- Docs: README rewritten around the new guarantees, submission and demo script updated,
  Round 5 added to the expert reviews, this changelog.
- Tests: 144 → 199 (198 offline + 1 opt-in live model check).

## 1.1.0 — 2026-11-25

- Integrated WebLLM (WebGPU device engine), transformers.js (semantic signal, duplicate
  removal) and a Presidio-derived entity layer with Korean checksums.
- Korean keyword rules fixed (`\b` never matches Hangul), phone/account overlap resolved.
- Ledger, receipt, map-reduce, cancel and Remote Config model override verified.

## 1.0.0 — 2026-11-24

- First complete build: local scan, router, Firebase AI Logic hybrid inference, privacy
  receipt, ledger, MV3 side panel, Cloudflare Pages deployment.
