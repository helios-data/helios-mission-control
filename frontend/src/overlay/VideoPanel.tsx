import { useEffect, useRef, useState } from "react";
import type { MissionConfig } from "../lib/telemetry";
import { playWhep, type WhepSession } from "../lib/whep";

// Two run-mode-driven video methods (the backend sets ui.video_source):
//   webrtc-url    — production: pull the go2rtc Video node's WHEP restream, so
//                   both OBS and this overlay share the single capture card.
//   local-capture — STANDALONE only: no go2rtc node running, so read the capture
//                   card directly in the browser via getUserMedia.
export function VideoPanel({ config }: { config: MissionConfig }) {
  const mode = config.ui?.video_source ?? "webrtc-url";
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

    // webrtc-url
    if (!videoUrl) { setErr("no ui.video_url configured for webrtc-url mode"); return; }
    let session: WhepSession | null = null;
    let retry: number | undefined;
    let cancelled = false;

    const connect = async () => {
      try {
        session = await playWhep(videoUrl, video, (state) => {
          if (state === "connected") setLive(true);
          if (state === "failed" || state === "disconnected") { setLive(false); scheduleRetry(); }
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
    return () => { cancelled = true; window.clearTimeout(retry); session?.close(); };
  }, [mode, videoUrl]);

  return (
    <div className="video-fit">
      <div className="video-box">
        <video ref={videoRef} autoPlay muted playsInline style={{ display: live ? "block" : "none" }} />
        {!live && (
          <div className="no-signal">
            <span className="icon">◉</span>
            <span className="upper">No signal · stream offline</span>
            {mode === "webrtc-url" && <span className="mono" style={{ fontSize: 10 }}>connecting to {videoUrl}…</span>}
            {mode === "local-capture" && <span className="mono" style={{ fontSize: 10 }}>waiting for camera permission…</span>}
            {err && <span className="mono" style={{ fontSize: 10, color: "var(--err)" }}>{err}</span>}
          </div>
        )}
        {live && <span className="video-live-dot" title="live" />}
      </div>
    </div>
  );
}
