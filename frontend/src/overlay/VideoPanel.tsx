import { useEffect, useRef, useState } from "react";
import type { MissionConfig } from "../lib/telemetry";
import { playWhep, type WhepSession } from "../lib/whep";

// Three video_source modes (§6 item 2). All fall back to a designed NO SIGNAL
// state when no frames arrive. The public stream never depends on this panel:
// in transparent-window mode OBS owns the capture card and composites behind a
// chroma-keyed rectangle; in webrtc-url mode both OBS and this panel pull from
// the go2rtc sidecar (WHEP), so multiple consumers share the single capture card.
export function VideoPanel({ config }: { config: MissionConfig }) {
  const mode = config.ui?.video_source ?? "transparent-window";
  const videoUrl = config.ui?.video_url;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLive(false);
    setErr(null);
    const video = videoRef.current;
    if (!video) return;

    if (mode === "local-capture") {
      let stream: MediaStream | null = null;
      navigator.mediaDevices
        ?.getUserMedia({ video: true, audio: false })
        .then((s) => { stream = s; video.srcObject = s; setLive(true); })
        .catch((e) => setErr(String(e)));
      return () => { stream?.getTracks().forEach((t) => t.stop()); };
    }

    if (mode === "webrtc-url") {
      if (!videoUrl) { setErr("no ui.video_url configured for webrtc-url mode"); return; }
      let session: WhepSession | null = null;
      let retry: number | undefined;
      let cancelled = false;

      const connect = async () => {
        try {
          session = await playWhep(videoUrl, video, (state) => {
            if (state === "connected") setLive(true);
            if (state === "failed" || state === "disconnected") {
              setLive(false);
              scheduleRetry();
            }
          });
          setErr(null);
        } catch (e) {
          if (!cancelled) { setErr(String(e)); scheduleRetry(); }
        }
      };
      const scheduleRetry = () => {
        if (cancelled) return;
        window.clearTimeout(retry);
        retry = window.setTimeout(() => { session?.close(); connect(); }, 3000);
      };

      connect();
      return () => {
        cancelled = true;
        window.clearTimeout(retry);
        session?.close();
      };
    }

    return undefined; // transparent-window: no video element wiring
  }, [mode, videoUrl]);

  if (mode === "transparent-window") {
    return (
      <div className="video-fit">
        <div className="video-box keyed">
          {/* OBS composites the capture-card feed behind this chroma-key rectangle */}
          <span className="no-signal" style={{ color: "#04120a" }}>
            <span className="icon">▣</span>
            <span className="upper">OBS composite region</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="video-fit">
      <div className="video-box">
        <video ref={videoRef} autoPlay muted playsInline style={{ display: live ? "block" : "none" }} />
        {!live && (
          <div className="no-signal">
            <span className="icon">◉</span>
            <span className="upper">No signal · stream offline</span>
            {mode === "webrtc-url" && <span className="mono" style={{ fontSize: 10 }}>connecting to {videoUrl}…</span>}
            {mode === "local-capture" && (
              <span className="mono" style={{ fontSize: 10, maxWidth: 460, textAlign: "center" }}>
                local-capture needs camera permission and is not available inside OBS — use
                <b> transparent-window</b> or <b> webrtc-url</b> for the OBS browser source
              </span>
            )}
            {err && <span className="mono" style={{ fontSize: 10, color: "var(--err)" }}>{err}</span>}
          </div>
        )}
        {live && <span className="video-live-dot" title="live" />}
      </div>
    </div>
  );
}
