import { useState } from "react";
import { clearFirebaseConfig, saveAppCheck, saveFirebaseConfigPaste, type AppConfig } from "../engine/config";

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  onClose: () => void;
}

export function SettingsPanel({ config, onChange, onClose }: Props) {
  const [paste, setPaste] = useState("");
  const [siteKey, setSiteKey] = useState(config.appCheck.siteKey ?? "");
  const [debugToken, setDebugToken] = useState(config.appCheck.debugToken ?? "");
  const [note, setNote] = useState<string | null>(null);

  const save = () => {
    const configuredProject = config.firebase?.projectId;
    if (paste.trim()) {
      if (!saveFirebaseConfigPaste(paste)) {
        setNote("That does not look like a Firebase config. Paste the object that starts with { apiKey: … }.");
        return;
      }
    }
    if (siteKey.trim() || debugToken.trim()) {
      saveAppCheck({ siteKey: siteKey.trim() || undefined, debugToken: debugToken.trim() || undefined });
    }
    if (!paste.trim() && !configuredProject) {
      setNote("Paste a Firebase web app config first (it contains apiKey and projectId).");
      return;
    }
    setNote("Saved. Reloading so App Check starts with the new settings…");
    setTimeout(() => window.location.reload(), 400);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(event) => event.stopPropagation()}>
        <h2>Connect Firebase AI Logic</h2>
        <p>
          VaultBrief calls Gemini through Firebase AI Logic, which needs a Firebase project and App Check. The
          config is public (it identifies the project, it authorises nothing) but it is stored in this browser
          only, never in the repository.
        </p>

        <div className="field-label">Firebase web app config</div>
        <textarea
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          placeholder={`{\n  "apiKey": "AIza…",\n  "authDomain": "your-project.firebaseapp.com",\n  "projectId": "your-project",\n  "appId": "1:1234567890:web:abc123"\n}`}
          spellCheck={false}
        />

        <div className="field-label" style={{ marginTop: 12 }}>
          App Check · reCAPTCHA Enterprise site key (production)
        </div>
        <textarea
          style={{ minHeight: 42 }}
          value={siteKey}
          onChange={(event) => setSiteKey(event.target.value)}
          placeholder="6Lc…"
          spellCheck={false}
        />

        <div className="field-label" style={{ marginTop: 12 }}>
          App Check · debug token (review builds — the hackathon accepts debug tokens)
        </div>
        <textarea
          style={{ minHeight: 42 }}
          value={debugToken}
          onChange={(event) => setDebugToken(event.target.value)}
          placeholder="123a4567-b89c-12d3-e456-789012345678"
          spellCheck={false}
        />

        <div className="drawer-actions">
          <button className="primary" onClick={save}>
            Save &amp; reload
          </button>
          <button
            className="ghost"
            onClick={() => {
              clearFirebaseConfig();
              setPaste("");
              setNote("Firebase config cleared. Reload to return to demo mode.");
              onChange({ ...config, firebase: null });
            }}
          >
            Clear
          </button>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {note && <p style={{ marginTop: 12, color: "var(--accent)" }}>{note}</p>}

        <ol className="steps">
          <li>Create a project at <code>console.firebase.google.com</code> and add a Web app.</li>
          <li>Copy the <code>firebaseConfig</code> object from the app settings into the box above.</li>
          <li>
            Provision AI Logic for the project: <code>npx -y firebase-tools@latest init ailogic</code>. Without
            this step every call fails with PERMISSION_DENIED.
          </li>
          <li>
            Security → App Check → register the web app with reCAPTCHA Enterprise, or add a debug token and paste
            it above. Enforce App Check for Firebase AI Logic.
          </li>
          <li>Optionally enable Firestore + Anonymous Auth to mirror receipts; the app works without them.</li>
        </ol>

        <p style={{ marginTop: 12, fontSize: 11.5, color: "var(--dim)" }}>
          Current project: {config.firebase?.projectId ?? "none"} · App Check:{" "}
          {config.appCheck.siteKey ? "reCAPTCHA Enterprise" : config.appCheck.debugToken ? "debug token" : "not set"}
        </p>
      </div>
    </div>
  );
}
