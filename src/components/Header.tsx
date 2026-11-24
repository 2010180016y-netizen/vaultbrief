export function Header({
  live,
  configComplete,
  onOpenSettings,
}: {
  live: boolean;
  configComplete: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect x="4.5" y="10" width="15" height="10.5" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
            <path d="M8 10V7.2a4 4 0 0 1 8 0V10" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        </span>
        <div>
          <h1>VaultBrief</h1>
          <p>Brief anything. Keep what&apos;s private private.</p>
        </div>
      </div>

      <div className="topbar-spacer" />

      <span className={`badge ${live ? "live" : "sim"}`}>
        <span className="dot" />
        {live ? "LIVE · Firebase AI Logic" : "DEMO · simulated responses"}
      </span>
      <button className="ghost" onClick={onOpenSettings}>
        {live ? "Settings" : configComplete ? "Reconnect" : "Connect Firebase"}
      </button>
    </div>
  );
}
