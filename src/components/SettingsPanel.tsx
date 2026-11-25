import { useState } from "react";
import {
  clearAppCheck,
  clearFirebaseConfig,
  parseFirebaseConfigPaste,
  saveAppCheck,
  saveFirebaseConfigPaste,
  type AppConfig,
  type EnginePreference,
  type LocalModelConfig,
} from "../engine/config";
import { WEBLLM_MODELS } from "../engine/webllm";

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  local: LocalModelConfig;
  onLocal: (patch: Partial<LocalModelConfig>) => void;
  /** One-line status of the resolved on-device engine. */
  runtimeNote: string;
  webgpuNote: string;
  onClose: () => void;
}

const ENGINES: { id: EnginePreference; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Gemini Nano when this Chrome has it, otherwise WebLLM on WebGPU." },
  { id: "nano", label: "Gemini Nano", hint: "Only Chrome 139+ desktop with the built-in AI model." },
  { id: "webllm", label: "WebLLM", hint: "A quantised open model on WebGPU; works in Edge and Chrome 121+." },
];

export function SettingsPanel({ config, onChange, local, onLocal, runtimeNote, webgpuNote, onClose }: Props) {
  const [paste, setPaste] = useState("");
  const [siteKey, setSiteKey] = useState(config.appCheck.siteKey ?? "");
  const [debugToken, setDebugToken] = useState(config.appCheck.debugToken ?? "");
  const [note, setNote] = useState<string | null>(null);

  const parsedPaste = paste.trim() ? parseFirebaseConfigPaste(paste) : null;
  const willHaveProject = Boolean(parsedPaste?.projectId ?? config.firebase?.projectId);
  const willHaveAppCheck = Boolean(siteKey.trim() || debugToken.trim() || config.appCheck.siteKey || config.appCheck.debugToken);

  const save = () => {
    if (paste.trim() && !parsedPaste) {
      setNote(
        "That does not look like a Firebase config. Paste the object that starts with { apiKey: …, projectId: … }.",
      );
      return;
    }
    if (!willHaveProject) {
      setNote("Paste a Firebase web app config first (it contains apiKey and projectId).");
      return;
    }
    if (!willHaveAppCheck) {
      setNote(
        "App Check is required for Firebase AI Logic. Add a reCAPTCHA Enterprise site key, or a debug token registered in the Firebase console, then save.",
      );
      return;
    }

    if (paste.trim() && !saveFirebaseConfigPaste(paste)) {
      setNote("The config could not be stored in this browser (storage blocked?).");
      return;
    }
    saveAppCheck({ siteKey: siteKey.trim() || undefined, debugToken: debugToken.trim() || undefined });
    setNote("Saved. Reloading so App Check starts with the new settings…");
    setTimeout(() => window.location.reload(), 400);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(event) => event.stopPropagation()}>
        <h2>On-device engine</h2>
        <p style={{ marginBottom: 6 }}>{runtimeNote}</p>
        <div className="segmented" role="group" aria-label="On-device engine">
          {ENGINES.map((engine) => (
            <button
              key={engine.id}
              className={local.engine === engine.id ? "on" : ""}
              title={engine.hint}
              aria-pressed={local.engine === engine.id}
              onClick={() => onLocal({ engine: engine.id })}
            >
              {engine.label}
            </button>
          ))}
        </div>
        <div className="field-label" style={{ marginTop: 10 }}>
          WebLLM model
        </div>
        <select
          value={local.webllmModel}
          onChange={(event) => onLocal({ webllmModel: event.target.value })}
          aria-label="WebLLM model"
          style={{ width: "100%", padding: "7px 8px", fontSize: 12.5 }}
        >
          {WEBLLM_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} · {model.sizeMb} MB VRAM
            </option>
          ))}
        </select>
        <p style={{ marginTop: 6, fontSize: 11.5, color: "var(--dim)" }}>{webgpuNote}</p>

        <button
          className="switch"
          type="button"
          role="switch"
          aria-checked={local.embeddings}
          onClick={() => onLocal({ embeddings: !local.embeddings })}
          style={{ marginTop: 8 }}
        >
          <span className="switch-text">
            <strong>transformers.js local embeddings</strong>
            <span>Semantic sensitivity and near-duplicate removal, on this device.</span>
          </span>
          <span className={`toggle ${local.embeddings ? "on" : ""}`} aria-hidden />
        </button>

        <h2 style={{ marginTop: 18 }}>Connect Firebase AI Logic</h2>
        <p>
          VaultBrief calls Gemini through Firebase AI Logic, which needs a Firebase project and App Check. The
          config is public (it identifies the project, it authorises nothing) and it is stored in this browser
          only, never in the repository. You can close this drawer and use demo mode at any time.
        </p>

        <div className="field-label">Firebase web app config</div>
        <textarea
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          placeholder={`{\n  "apiKey": "AIza…",\n  "authDomain": "your-project.firebaseapp.com",\n  "projectId": "your-project",\n  "appId": "1:1234567890:web:abc123"\n}`}
          spellCheck={false}
          aria-label="Firebase web app config"
        />
        {parsedPaste && (
          <p style={{ marginTop: 6, fontSize: 11.5, color: "var(--device)" }}>
            Parsed: project <code>{parsedPaste.projectId}</code>
            {parsedPaste.appId ? " · web app id found" : " · no appId (optional)"}
          </p>
        )}

        <div className="field-label" style={{ marginTop: 12 }}>
          App Check · reCAPTCHA Enterprise site key (production)
        </div>
        <textarea
          style={{ minHeight: 42 }}
          value={siteKey}
          onChange={(event) => setSiteKey(event.target.value)}
          placeholder="6Lc…"
          spellCheck={false}
          aria-label="reCAPTCHA Enterprise site key"
        />

        <div className="field-label" style={{ marginTop: 12 }}>
          App Check · debug token (review builds — register it in the console first)
        </div>
        <textarea
          style={{ minHeight: 42 }}
          value={debugToken}
          onChange={(event) => setDebugToken(event.target.value)}
          placeholder="123a4567-b89c-12d3-e456-789012345678"
          spellCheck={false}
          aria-label="App Check debug token"
        />

        <div className="drawer-actions">
          <button className="primary" onClick={save}>
            Save &amp; reload
          </button>
          <button
            className="ghost"
            onClick={() => {
              clearFirebaseConfig();
              clearAppCheck();
              setPaste("");
              setSiteKey("");
              setDebugToken("");
              setNote("Firebase config and App Check credentials cleared. Reload to return to demo mode.");
              onChange({ ...config, firebase: null, appCheck: {} });
            }}
          >
            Clear all
          </button>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {note && (
          <p style={{ marginTop: 12, color: "var(--accent)" }} role="status">
            {note}
          </p>
        )}

        <ol className="steps">
          <li>
            Create a project at <code>console.firebase.google.com</code> and add a Web app.
          </li>
          <li>
            Copy the <code>firebaseConfig</code> object from the app settings into the box above.
          </li>
          <li>
            Provision AI Logic for the project: <code>npx -y firebase-tools@latest init ailogic</code>. Without
            this step every call fails with PERMISSION_DENIED.
          </li>
          <li>
            Security → App Check → register the web app with reCAPTCHA Enterprise, or register a debug token and
            paste it above. Enforce App Check for Firebase AI Logic.
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
