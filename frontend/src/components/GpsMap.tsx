import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { SERIES } from "../lib/colors";
import type { MissionStore } from "../lib/store";
import { PlotLegend } from "./PlotLegend";

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

export function GpsMap({
  store, height = 260, theme = "dark", fill = false,
}: {
  store: MissionStore;
  height?: number;
  theme?: "dark" | "light";
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const fitted = useRef(false);

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
      const emptyLine = { type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection;
      map.addSource("srad-track", { type: "geojson", data: emptyLine });
      map.addSource("cots-track", { type: "geojson", data: emptyLine });
      map.addSource("srad-pos", { type: "geojson", data: point(null) });
      map.addSource("cots-pos", { type: "geojson", data: point(null) });
      map.addSource("ground", { type: "geojson", data: point(center) });
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

      const timer = window.setInterval(() => {
        const st = store.sradTrack, ct = store.cotsTrack;
        (map.getSource("srad-track") as maplibregl.GeoJSONSource)?.setData(
          { type: "FeatureCollection", features: [line(st)] } as GeoJSON.FeatureCollection);
        (map.getSource("cots-track") as maplibregl.GeoJSONSource)?.setData(
          { type: "FeatureCollection", features: [line(ct)] } as GeoJSON.FeatureCollection);
        (map.getSource("srad-pos") as maplibregl.GeoJSONSource)?.setData(point(st.at(-1) ?? null));
        (map.getSource("cots-pos") as maplibregl.GeoJSONSource)?.setData(point(ct.at(-1) ?? null));
        if (!fitted.current && st.length > 3) {
          fitted.current = true;
          const b = new maplibregl.LngLatBounds();
          [...st, ...ct, center].forEach((c) => b.extend(c));
          map.fitBounds(b, { padding: 40, maxZoom: 14, duration: 500 });
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

  return (
    <div style={{ position: "relative", width: "100%", height: fill ? "100%" : height, borderRadius: 4, overflow: "hidden" }}>
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
      <PlotLegend
        corner="tl"
        items={[
          { label: "SRAD", color: SERIES.sradTrack },
          { label: "COTS", color: SERIES.cotsTrack, dash: true },
          { label: "Ground", color: "#e6ebf2", dot: true },
        ]}
      />
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
