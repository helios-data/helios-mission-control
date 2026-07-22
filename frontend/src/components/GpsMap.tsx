import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PREDICTION, SERIES } from "../lib/colors";
import type { MissionStore } from "../lib/store";
import type { LandingPoint } from "../lib/telemetry";
import { PlotLegend, type LegendItem } from "./PlotLegend";

// Basemap tiles come from the backend caching proxy (/api/tiles): fetched once
// when online, cached on disk, served offline thereafter. Missing tiles are
// transparent and fall through to the background, so the map still works with no
// connectivity. Tiles are dimmed/desaturated to fit the dark theme; in light
// mode they render closer to normal.
function mapStyle(theme: "dark" | "light"): maplibregl.StyleSpecification {
  const dark = theme === "dark";
  return {
    version: 8,
    sources: {
      osm: { type: "raster", tiles: ["/api/tiles/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19 },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": dark ? "#0a0e14" : "#e7ecf3" } },
      {
        id: "osm",
        type: "raster",
        source: "osm",
        paint: dark
          ? { "raster-opacity": 0.8, "raster-saturation": -0.4, "raster-brightness-max": 0.75 }
          : { "raster-opacity": 1, "raster-saturation": -0.1 },
      },
    ],
  };
}

function line(coords: [number, number][]): GeoJSON.Feature {
  return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} };
}
function point(c: [number, number] | null): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: c ? [{ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} }] : [],
  };
}
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// A landing-prediction ellipse (list of vertices) -> a closed-ring Polygon.
function polygon(pts: LandingPoint[]): GeoJSON.FeatureCollection {
  if (!pts || pts.length < 3) return EMPTY;
  const ring = pts.map((p) => [p.lon, p.lat] as [number, number]);
  ring.push(ring[0]);
  return { type: "FeatureCollection", features: [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} },
  ] };
}
// The sampled Monte-Carlo dispersion points -> a multipoint FeatureCollection.
function multipoint(pts: LandingPoint[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (pts ?? []).map((p) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: {},
    })),
  };
}

// --- auto-fit helpers -----------------------------------------------------
// Rough diagonal extent (degrees) — a scalar size for comparing bounds so the
// map only re-fits when the framed area grows or shrinks meaningfully.
function spanDeg(b: maplibregl.LngLatBounds): number {
  return Math.hypot(b.getEast() - b.getWest(), b.getNorth() - b.getSouth());
}
// Never fit tighter than ~this, so a degenerate (single-point / tiny) target
// doesn't zoom to the max and jitter.
const MIN_FIT_SPAN_DEG = 0.008; // ~0.9 km
function withMinSpan(b: maplibregl.LngLatBounds): maplibregl.LngLatBounds {
  const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const hx = Math.max((e - w) / 2, MIN_FIT_SPAN_DEG / 2);
  const hy = Math.max((n - s) / 2, MIN_FIT_SPAN_DEG / 2);
  return new maplibregl.LngLatBounds([cx - hx, cy - hy], [cx + hx, cy + hy]);
}

export function GpsMap({
  store, height = 260, theme = "dark", fill = false, showPrediction = false, autoFit = false,
}: {
  store: MissionStore;
  height?: number;
  theme?: "dark" | "light";
  fill?: boolean;
  // Overlay the LandingPredictor's touchdown estimate (best point + 50/90%
  // ellipses + dispersion cloud). Always on for /admin; toggled on /overlay.
  showPrediction?: boolean;
  // Auto-fit the viewport to the rocket + landing zone, re-fitting as that area
  // grows OR shrinks. Toggled on /admin; always on for /overlay. When off, the
  // map fits once on first data and is then free to pan/zoom.
  autoFit?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Read the latest prop values inside the map's update interval without
  // recreating the map when they flip (overlay/admin toggles).
  const showPredRef = useRef(showPrediction);
  showPredRef.current = showPrediction;
  const autoFitRef = useRef(autoFit);
  const wasAutoFit = useRef(autoFit);
  const didInitialFit = useRef(false);
  const lastFitSpan = useRef<number | null>(null);
  autoFitRef.current = autoFit;

  useEffect(() => {
    if (!ref.current) return;
    const gs = store.config.ground_station;
    const center: [number, number] = gs ? [gs.lon, gs.lat] : [-106.9749, 32.9903];
    const map = new maplibregl.Map({
      container: ref.current,
      style: mapStyle(theme),
      center,
      zoom: 12,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("srad-track", { type: "geojson", data: EMPTY });
      map.addSource("cots-track", { type: "geojson", data: EMPTY });
      map.addSource("srad-pos", { type: "geojson", data: point(null) });
      map.addSource("cots-pos", { type: "geojson", data: point(null) });
      map.addSource("ground", { type: "geojson", data: point(center) });
      // Landing-prediction sources (empty until a prediction arrives / is shown).
      map.addSource("pred-e90", { type: "geojson", data: EMPTY });
      map.addSource("pred-e50", { type: "geojson", data: EMPTY });
      map.addSource("pred-cloud", { type: "geojson", data: EMPTY });
      map.addSource("pred-best", { type: "geojson", data: point(null) });

      // Prediction ellipse fills go on the bottom so tracks/markers read over them.
      map.addLayer({ id: "pred-e90-fill", type: "fill", source: "pred-e90",
        paint: { "fill-color": PREDICTION.ellipse90, "fill-opacity": 0.12 } });
      map.addLayer({ id: "pred-e90-line", type: "line", source: "pred-e90",
        paint: { "line-color": PREDICTION.ellipse90, "line-width": 1, "line-dasharray": [2, 2] } });
      map.addLayer({ id: "pred-e50-fill", type: "fill", source: "pred-e50",
        paint: { "fill-color": PREDICTION.ellipse50, "fill-opacity": 0.18 } });
      map.addLayer({ id: "pred-e50-line", type: "line", source: "pred-e50",
        paint: { "line-color": PREDICTION.ellipse50, "line-width": 1.5 } });
      map.addLayer({ id: "pred-cloud", type: "circle", source: "pred-cloud",
        paint: { "circle-radius": 1.6, "circle-color": PREDICTION.cloud, "circle-opacity": 0.5 } });

      map.addLayer({ id: "srad-track", type: "line", source: "srad-track",
        paint: { "line-color": SERIES.sradTrack, "line-width": 2 } });
      map.addLayer({ id: "cots-track", type: "line", source: "cots-track",
        paint: { "line-color": SERIES.cotsTrack, "line-width": 2, "line-dasharray": [2, 1] } });
      map.addLayer({ id: "ground", type: "circle", source: "ground",
        paint: { "circle-radius": 5, "circle-color": "#e6ebf2", "circle-stroke-color": "#0a0e14", "circle-stroke-width": 2 } });
      map.addLayer({ id: "srad-pos", type: "circle", source: "srad-pos",
        paint: { "circle-radius": 6, "circle-color": SERIES.sradTrack, "circle-stroke-color": "#0a0e14", "circle-stroke-width": 2 } });
      map.addLayer({ id: "cots-pos", type: "circle", source: "cots-pos",
        paint: { "circle-radius": 6, "circle-color": SERIES.cotsTrack, "circle-stroke-color": "#0a0e14", "circle-stroke-width": 2 } });
      // Best-estimate touchdown marker sits on top (a filled ✕-style dot).
      map.addLayer({ id: "pred-best", type: "circle", source: "pred-best",
        paint: { "circle-radius": 6, "circle-color": PREDICTION.estimate, "circle-stroke-color": "#0a0e14", "circle-stroke-width": 2 } });

      const timer = window.setInterval(() => {
        const st = store.sradTrack, ct = store.cotsTrack;
        (map.getSource("srad-track") as maplibregl.GeoJSONSource)?.setData(
          { type: "FeatureCollection", features: [line(st)] } as GeoJSON.FeatureCollection);
        (map.getSource("cots-track") as maplibregl.GeoJSONSource)?.setData(
          { type: "FeatureCollection", features: [line(ct)] } as GeoJSON.FeatureCollection);
        (map.getSource("srad-pos") as maplibregl.GeoJSONSource)?.setData(point(st.at(-1) ?? null));
        (map.getSource("cots-pos") as maplibregl.GeoJSONSource)?.setData(point(ct.at(-1) ?? null));

        // Landing prediction: fed only when enabled + present, else cleared.
        const lp = showPredRef.current ? store.landing : null;
        (map.getSource("pred-e90") as maplibregl.GeoJSONSource)?.setData(lp ? polygon(lp.ellipse_90) : EMPTY);
        (map.getSource("pred-e50") as maplibregl.GeoJSONSource)?.setData(lp ? polygon(lp.ellipse_50) : EMPTY);
        (map.getSource("pred-cloud") as maplibregl.GeoJSONSource)?.setData(lp ? multipoint(lp.dispersion_cloud) : EMPTY);
        (map.getSource("pred-best") as maplibregl.GeoJSONSource)?.setData(
          point(lp?.best_estimate ? [lp.best_estimate.lon, lp.best_estimate.lat] : null));

        // --- viewport auto-fit --------------------------------------------
        // Target = the active area: latest rocket fix(es) + the shown landing
        // zone (best estimate + 90% ellipse); the pad is a fallback so we always
        // have something to frame. Auto-fit re-frames when that area moves out of
        // view OR changes size (so it shrinks back as the zone tightens); when
        // off, we still fit once so the map isn't stuck at the default zoom.
        const framePts: [number, number][] = [];
        const sp = st.at(-1); if (sp) framePts.push(sp);
        const cp = ct.at(-1); if (cp) framePts.push(cp);
        if (lp?.best_estimate) {
          framePts.push([lp.best_estimate.lon, lp.best_estimate.lat]);
          for (const p of lp.ellipse_90) framePts.push([p.lon, p.lat]);
        }
        if (framePts.length === 0) framePts.push(center);

        const auto = autoFitRef.current;
        const turnedOn = auto && !wasAutoFit.current;
        wasAutoFit.current = auto;

        if (auto || !didInitialFit.current) {
          const target = withMinSpan(
            framePts.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(framePts[0], framePts[0])),
          );
          const span = spanDeg(target);
          const last = lastFitSpan.current;
          const outside = auto && framePts.some((c) => !map.getBounds().contains(c));
          const resized = auto && last !== null && (span > last * 1.3 || span < last * 0.75);
          if (!didInitialFit.current || turnedOn || outside || resized) {
            map.fitBounds(target, { padding: 50, maxZoom: 16, duration: 500 });
            lastFitSpan.current = span;
            didInitialFit.current = true;
          }
        }
      }, 500);
      (map as unknown as { _hmcTimer: number })._hmcTimer = timer;
    });

    return () => {
      const t = (map as unknown as { _hmcTimer?: number })._hmcTimer;
      if (t) window.clearInterval(t);
      map.remove();
    };
  }, [store, theme]);

  const legend: LegendItem[] = [
    { label: "SRAD", color: SERIES.sradTrack },
    { label: "COTS", color: SERIES.cotsTrack, dash: true },
    { label: "Ground", color: "#e6ebf2", dot: true },
  ];
  if (showPrediction) legend.push({ label: "Landing", color: PREDICTION.estimate, dot: true });

  return (
    <div style={{ position: "relative", width: "100%", height: fill ? "100%" : height, borderRadius: 4, overflow: "hidden" }}>
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
      <PlotLegend corner="tl" items={legend} />
      <span
        style={{
          position: "absolute", bottom: 2, right: 4, fontSize: 9, color: "rgba(230,235,242,0.5)",
          background: "rgba(10,14,20,0.5)", padding: "0 4px", borderRadius: 2, pointerEvents: "none",
        }}
      >
        © OpenStreetMap
      </span>
    </div>
  );
}
