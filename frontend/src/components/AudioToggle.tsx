// Admin-only audio-callouts toggle (speaker on/off, inline SVG).
export function AudioToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={on ? "Mute audio callouts" : "Enable audio callouts"}
      aria-label="Toggle audio callouts"
      className={on ? "on" : ""}
      style={{ padding: "4px 7px", display: "inline-flex", alignItems: "center", lineHeight: 1 }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M4 9v6h4l5 5V4L8 9H4z" />
        {on ? (
          <path d="M16 8a4 4 0 0 1 0 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        ) : (
          <path d="M17 9l4 6M21 9l-4 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        )}
      </svg>
    </button>
  );
}
