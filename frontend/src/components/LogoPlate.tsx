import { useEffect, useRef, useState } from "react";
import { fitLogo, loadLogo, type LogoInfo } from "../lib/logo";

/**
 * One sponsor logo on a self-sizing plate.
 *
 * The plate colour and the crop both come from analysing the image's pixels (see
 * lib/logo.ts) — the caller supplies nothing but a URL. Every plate has the same
 * geometry regardless of what it contains, which is what lets a folder of
 * mismatched supplied logos read as a deliberate wall.
 */
export function LogoPlate({ src, alt }: { src: string; alt?: string }) {
  const [info, setInfo] = useState<LogoInfo | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const fitRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setInfo(null);
    loadLogo(src).then((i) => { if (live) setInfo(i); });
    return () => { live = false; };
  }, [src]);

  // The crop maths needs the tile's inner size in real pixels, and the grid sizes
  // tiles from the panel height, so measure rather than assume.
  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const placed = info && box.w > 0 && box.h > 0 ? fitLogo(info, box.w, box.h) : null;

  return (
    <div
      className={`logo-plate ${info?.lightInk ? "on-dark" : ""}`}
      style={info ? { background: info.plate } : undefined}
    >
      <div className="logo-fit" ref={fitRef}>
        {placed && (
          <img
            src={src}
            alt={alt ?? ""}
            style={{
              position: "absolute",
              width: placed.width,
              height: placed.height,
              left: placed.left,
              top: placed.top,
              maxWidth: "none",
            }}
          />
        )}
      </div>
    </div>
  );
}
