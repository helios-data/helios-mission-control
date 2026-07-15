import { useEffect, useRef, useState } from "react";
import { eventSpeech } from "./eventmeta";
import type { MissionStore } from "./store";

const KEY = "hmc-audio";
const ALT_STEP_M = 500; // spoken altitude callout interval during ascent

export function useAudioEnabled(): [boolean, () => void] {
  const [on, setOn] = useState(() => localStorage.getItem(KEY) === "1");
  useEffect(() => {
    localStorage.setItem(KEY, on ? "1" : "0");
    if (!on && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [on]);
  return [on, () => setOn((p) => !p)];
}

// Speaks auto-detected events + altitude callouts every 500 m on ascent.
// Admin-only. When toggled on mid-flight it seeds "already spoken" so it doesn't
// dump the whole event history at once.
export function useAudioCallouts(store: MissionStore, enabled: boolean): void {
  const spoken = useRef(new Set<string>());
  const lastAltStep = useRef(0);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) {
      // seed so only FUTURE events/altitudes are announced
      for (const e of store.events) spoken.current.add(e.type);
      lastAltStep.current = Math.floor((store.srad?.altitude_agl_m ?? 0) / ALT_STEP_M);
    }
  }, [enabled, store]);

  useEffect(() => {
    const speak = (text: string) => {
      if (!enabledRef.current || !("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    };
    const check = () => {
      if (!enabledRef.current) return;
      for (const e of store.events) {
        if (!spoken.current.has(e.type)) {
          spoken.current.add(e.type);
          speak(eventSpeech(e.type, e.altitude_agl_m));
        }
      }
      const s = store.srad;
      const state = store.mission?.flight_state;
      if (s && (state === "ASCENT" || state === "MACH_LOCK")) {
        const step = Math.floor(s.altitude_agl_m / ALT_STEP_M);
        if (step > lastAltStep.current && step > 0) {
          lastAltStep.current = step;
          speak(`${step * ALT_STEP_M} meters`);
        }
      }
    };
    const unsub = store.subscribe(check);
    return () => { unsub(); };
  }, [store]);
}
