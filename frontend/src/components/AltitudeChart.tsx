import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { SERIES } from "../lib/colors";
import type { MissionStore } from "../lib/store";
import { PlotLegend, type LegendItem } from "./PlotLegend";

// Expected flight profile: [seconds_since_liftoff, altitude_agl_m][]
export type Profile = [number, number][];

type WindowMode = "full" | "follow";
const FOLLOW_SECONDS = 30;
const PREROLL_SECONDS = 5; // static window locks its start this long before ascent

function interp(profile: Profile, t: number): number | null {
  if (profile.length === 0 || t < profile[0][0] || t > profile[profile.length - 1][0]) return null;
  for (let i = 1; i < profile.length; i++) {
    if (t <= profile[i][0]) {
      const [t0, a0] = profile[i - 1];
      const [t1, a1] = profile[i];
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return a0 + f * (a1 - a0);
    }
  }
  return profile[profile.length - 1][1];
}

export function AltitudeChart({
  store, profile, height = 240, liveHz = 8, dark = true, fill = false,
}: {
  store: MissionStore;
  profile?: Profile;
  height?: number;
  liveHz?: number;
  dark?: boolean;
  fill?: boolean; // fill parent height instead of using `height`
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [mode, setMode] = useState<WindowMode>("full");
  const modeRef = useRef<WindowMode>(mode);
  const liftoffRef = useRef(0);
  modeRef.current = mode;

  useEffect(() => {
    if (!ref.current) return;
    const measuredH = () => (fill ? Math.max(120, ref.current!.clientHeight) : height);
    const stroke = dark ? "#6b7385" : "#5a6472";
    const gridColor = dark ? "#1b2230" : "#d6dde8";
    const grid = { stroke: gridColor, width: 1 };
    const axis = { stroke, grid, ticks: grid, font: "11px Inconsolata, monospace" };

    // Event annotation markers: vertical dashed lines + top labels.
    const annotationPlugin: uPlot.Plugin = {
      hooks: {
        draw: (u) => {
          const { ctx } = u;
          const top = u.bbox.top;
          const bottom = u.bbox.top + u.bbox.height;
          ctx.save();
          ctx.font = "10px Inconsolata, monospace";
          ctx.textAlign = "center";
          for (const a of store.annotations) {
            if (a.x < u.scales.x.min! || a.x > u.scales.x.max!) continue;
            const px = Math.round(u.valToPos(a.x, "x", true));
            ctx.strokeStyle = a.color;
            ctx.globalAlpha = 0.55;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(px, top);
            ctx.lineTo(px, bottom);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
            ctx.fillStyle = a.color;
            ctx.fillText(a.label, px, top + 10);
          }
          ctx.restore();
        },
      },
    };

    const opts: uPlot.Options = {
      width: ref.current.clientWidth,
      height: measuredH(),
      padding: [16, 12, 4, 8],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      plugins: [annotationPlugin],
      scales: {
        x: {
          time: false,
          range: (_u, dataMin, dataMax) => {
            if (dataMax == null) return [0, 1];
            if (modeRef.current === "follow") {
              return [Math.max(dataMin ?? 0, dataMax - FOLLOW_SECONDS), dataMax];
            }
            // static full-flight: lock start a few seconds before ascent
            const start = liftoffRef.current > 0 ? liftoffRef.current - PREROLL_SECONDS : (dataMin ?? 0);
            return [start, dataMax];
          },
        },
      },
      axes: [
        { ...axis, values: (_u, vals) => vals.map((v) => `${v}s`) },
        { ...axis, size: 52, values: (_u, vals) => vals.map((v) => `${v}m`) },
      ],
      series: [
        { label: "t+ (s)" },
        { label: "Expected", stroke: SERIES.expected, width: 1, dash: [6, 5], points: { show: false } },
        { label: "Baro avg AGL", stroke: SERIES.baroAvg, width: 2, points: { show: false } },
        { label: "Kalman", stroke: SERIES.kf, width: 1, points: { show: false } },
        { label: "COTS AGL", stroke: SERIES.cots, width: 1.5, points: { show: false } },
      ],
    };
    const plot = new uPlot(opts, [[], [], [], [], []], ref.current);
    plotRef.current = plot;

    const ro = new ResizeObserver(() =>
      plot.setSize({ width: ref.current!.clientWidth, height: measuredH() }));
    ro.observe(ref.current);

    const timer = window.setInterval(() => {
      const a = store.alt;
      const n = a.x.length;
      if (n === 0) return;
      let liftoffX = 0;
      for (let i = 0; i < n; i++) { if (a.baroAvg[i] > 5) { liftoffX = a.x[i]; break; } }
      liftoffRef.current = liftoffX;
      const expected = profile
        ? a.x.map((x) => interp(profile, x - liftoffX))
        : new Array(n).fill(null);
      plot.setData([a.x, expected as number[], a.baroAvg, a.kf, a.cots as number[]]);
    }, 1000 / liveHz);

    return () => { window.clearInterval(timer); ro.disconnect(); plot.destroy(); };
  }, [store, profile, height, liveHz, dark, fill]);

  const legend: LegendItem[] = [
    { label: "Baro avg AGL", color: SERIES.baroAvg },
    { label: "Kalman", color: SERIES.kf },
    { label: "COTS AGL", color: SERIES.cots },
    ...(profile ? [{ label: "Expected", color: SERIES.expected, dash: true }] : []),
  ];

  return (
    <div style={{ position: "relative", height: fill ? "100%" : undefined }}>
      <PlotLegend items={legend} corner="bl" />
      <div
        style={{ position: "absolute", top: 2, right: 8, zIndex: 2, display: "flex", gap: 4 }}
      >
        <WindowBtn active={mode === "full"} onClick={() => setMode("full")} label="FULL" />
        <WindowBtn active={mode === "follow"} onClick={() => setMode("follow")} label="FOLLOW" />
      </div>
      <div ref={ref} style={{ width: "100%", height: fill ? "100%" : height }} />
    </div>
  );
}

function WindowBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "1px 7px", fontSize: 9, letterSpacing: "0.08em",
        borderColor: active ? "var(--accent-cyan)" : "var(--line)",
        color: active ? "var(--accent-cyan)" : "var(--text-dim)",
        background: active ? "color-mix(in srgb, var(--accent-cyan) 12%, transparent)" : "var(--bg-elev)",
      }}
    >
      {label}
    </button>
  );
}
