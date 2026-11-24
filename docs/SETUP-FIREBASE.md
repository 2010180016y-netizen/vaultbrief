# Connect VaultBrief to Firebase AI Logic

VaultBrief calls Gemini through Firebase AI Logic. The app is complete and runs without a project (demo mode), but the real hybrid path needs the five steps below. Expect 10–15 minutes.

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

- **Remote Config** — upload `remoteconfig.template.json` (console → Remote Config → ⋮ → Import). `sensitivity_threshold` and `cloud_model` are read on connect; defaults are used when it is absent.
- **Firestore + Anonymous Auth** — publish `firestore.rules`, enable Anonymous sign-in under Authentication. Receipts are then mirrored to `receipts/{id}` scoped to the anonymous user. Failures are ignored by design.

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
| On-device never runs | Chrome < 139, flag off, or the model is still downloading; the device panel shows `availability`. |
| `API key not valid` | The config belongs to another project, or the API key was restricted away from `firebasevertexai.googleapis.com`. |
