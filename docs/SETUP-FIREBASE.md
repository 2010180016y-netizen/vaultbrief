# Connect VaultBrief to Firebase AI Logic

VaultBrief calls Gemini through Firebase AI Logic. The app is complete and runs without a project (demo mode), but the real hybrid path needs the five steps below. Expect 10–15 minutes.

## Current deployment (2026-11-25)

A project is live and the production build points at it. Nothing here is a secret: the web
config and the reCAPTCHA site key are public by design, and the build takes them from
environment variables so the repository stays clean.

| Item | Value |
| --- | --- |
| Project | `vaultbrief-hybridai` (Spark, no billing account) |
| Web app | `VaultBrief Web` · appId `1:940139883309:web:283f9592bbc186da7a41a4` |
| AI Logic | Gemini Developer API enabled; AI monitoring off |
| App Check | Fraud Defense (reCAPTCHA Enterprise) site key `6LfqizEuAAAAAF0qmg8GLOSsFg-jUPCqTOw323UB`; **enforced** for AI Logic (replay protection not enforced) |
| Allowed origins on the key | `vaultbrief-bby.pages.dev`, `vaultbrief-hybridai.web.app`, `localhost` |
| Authentication | Anonymous, with 30-day auto-delete |
| Firestore | `(default)`, `asia-northeast3`, `firestore.rules` published |
| Remote Config | `sensitivity_threshold=40`, `cloud_model=gemini-3.5-flash-lite` |
| Hosts | https://vaultbrief-bby.pages.dev (submission), https://vaultbrief-hybridai.web.app |

No billing account was created and no paid tier was entered: Fraud Defense reported a
reCAPTCHA Enterprise assessment on the live run, and every other product here is inside the
Spark free quota. If a later change ever asks for Blaze, stop there instead of upgrading.

Without Firebase, the debug-token path in step 3 still works for a local review.

## 1. Create the project and a web app

1. <https://console.firebase.google.com> → **Add project** (Analytics is not needed).
2. In the project, **Project settings → Your apps → Web (</>)** and register an app. Copy the `firebaseConfig` object — you will paste it into the app's Settings drawer or into `.env.local`.

## 2. Provision AI Logic (required)

```bash
npx -y firebase-tools@latest login
npx -y firebase-tools@latest init ailogic
```

`init ailogic` enables the Gemini Developer API for the project and links it to AI Logic. Skipping it produces `PERMISSION_DENIED` on every call, even with a valid config.

## 3. Enable App Check

AI Logic requires App Check for this app.

**Production path (reCAPTCHA Enterprise)**

1. Google Cloud console → **reCAPTCHA Enterprise** → create a key for the site, type *Website*.
2. Add the deployment domains (`localhost` is not needed — it uses the debug token).
3. Firebase console → **Security → App Check → Apps → your web app → reCAPTCHA Enterprise**, paste the site key.
4. **Security → App Check → APIs → Firebase AI Logic → Enforce**.

**Review path (debug token — accepted by the hackathon rules)**

1. Run the app locally once; the console prints `AppCheck debug token: "…"`.
2. Firebase console → **App Check → Apps → ⋮ → Manage debug tokens → Add** and paste the UUID.
3. In `.env.local`: `VITE_APPCHECK_DEBUG_TOKEN=<that uuid>`.

A UUID string keeps the token stable across reloads; `true` mints a new one each session. Never commit a debug token.

## 4. Configure the app

`.env.local` (never committed):

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_APP_ID=...
VITE_APPCHECK_SITE_KEY=...        # or VITE_APPCHECK_DEBUG_TOKEN=...
```

Or paste the `firebaseConfig` object into the app's **Settings** drawer at runtime — useful for a hosted build that reviewers should be able to point at their own project.

## 5. Optional products

- **Remote Config** — upload `remoteconfig.template.json` (console → Remote Config → ⋮ → Import). `sensitivity_threshold` and `cloud_model` are read on connect (with an 8 s timeout, defaults on failure) and applied to every call; the routing console shows the effective threshold.
- **Firestore + Anonymous Auth** — publish `firestore.rules`, enable Anonymous sign-in under Authentication. Receipts are then mirrored to `receipts/{id}` scoped to the anonymous user. The rules check the shape and size of every field, and no document text is ever written. Failures are ignored by design.

## 6. Deploy

```bash
npm run build
npx firebase-tools deploy --only hosting      # dist/ is already the hosting root
```

Any static host works too (Cloudflare Pages, Netlify, S3): `base` is relative, and the build is a single-page app. After deploying, add the production domain to the App Check provider and keep the debug token out of production builds.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `PERMISSION_DENIED` on every call | AI Logic was not provisioned (`init ailogic`). |
| `403 … must enforce Firebase App Check` | `useLimitedUseAppCheckTokens` is required for generative models — the app sets it; check App Check is enforced for AI Logic, not just registered. |
| `App Check rejected this request` | The origin or debug token is not registered, or the token rotated. |
| On-device never runs | Chrome < 139, flag off, or the model is still downloading; the device panel shows `availability` and offers the download. |
| `API key not valid` | The config belongs to another project, or the API key was restricted away from `firebasevertexai.googleapis.com`. |
| `The configured cloud model does not exist` | Remote Config `cloud_model` names a model this project cannot use; clear the parameter or use `gemini-3.5-flash-lite`. |
| `The model did not answer in time` | The 90 s per-request timeout fired, or the network stalled. The run is not retried automatically; press Stop/Brief again. |
| Firestore: `permission-denied` on the receipt | Anonymous Auth is off, or the rules were not published. Receipts are optional; the brief still works. |
