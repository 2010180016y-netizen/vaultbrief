# VaultBrief side panel (Manifest V3)

A thin bridge, not a second app: it reads the readable text of the page you are
looking at and hands it to the VaultBrief web app running in the panel. Every
model call, App Check token and receipt still happens on the app's own origin,
so the extension never holds a Firebase key.

## Load it

1. `npm run dev` (or use your hosted VaultBrief URL).
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick this
   `extension/` folder.
3. Press the toolbar icon; the side panel opens (Chrome's side-panel menu also works).
4. Set **App URL** to `http://localhost:5173/` for development, or your deployed
   URL. The value is remembered in `chrome.storage.local`.
5. Open any article, press **Brief this page**. The panel shows how many
   characters were handed over; the app's routing console and receipt take it
   from there.

## Permissions, and why

| Permission | Why it is needed |
| --- | --- |
| `activeTab`, `scripting` | Read the text of the tab you pressed the button on. |
| `host_permissions: <all_urls>` | The reader must work on any article you open; the script only runs after your click. |
| `sidePanel` | Host the panel. |
| `storage` | Remember the app URL. |

No background network requests, no analytics, no remote script: `panel.js` is
the only code and it only talks to the origin you configure.

## Known limits

- Pages that block framing (`X-Frame-Options`, `frame-ancestors`) cannot be
  embedded; use **open in tab** and paste, or run the app on the same origin.
- Only text in `p`, `li`, `h1`–`h3` is collected, with a fallback to
  `innerText`; tables and canvas-heavy apps yield little text.
- The panel is capped at 20,000 characters (the app accepts 60,000) to keep
  message passing fast.
- Not exercised against a live Chrome profile by the automated tests; the
  manifest, file references, icon dimensions and CSP-relevant markup are checked
  by `npm run verify:extension`.
