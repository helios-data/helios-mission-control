/* Automatic logo treatment.
 *
 * Sponsor logos arrive as-is from whoever supplied them: transparent PNGs with
 * black artwork, opaque JPEGs on a white card, the occasional white-on-black
 * export. Dropped straight onto the overlay, roughly half of them are invisible
 * and the other half show a hard rectangle. Hand-tagging each one doesn't scale
 * when the folder is swapped by the launcher the morning of a launch.
 *
 * So we look at the pixels once, on load, and derive:
 *   - whether the image carries its own background (opaque) or not (alpha),
 *   - the colour of that background, if it has one,
 *   - whether the artwork ink is dark or light,
 *   - the tight bounding box of the ink.
 *
 * From that each logo gets a "plate" — a tile of identical geometry whose colour
 * guarantees contrast — and the bounding box is used to crop the baked-in
 * padding so every logo lands at the same optical size. Uniform geometry is what
 * makes a wall of mismatched logos read as one system; only the plate colour
 * varies, and only where it has to.
 *
 * Images are same-origin (served from /sponsors or /brand), so the canvas never
 * taints. If it somehow does, we fall back to a light plate — the safe default,
 * since the large majority of supplied logos are dark-ink-on-white.
 */

export type PlateKind = "light" | "dark" | "self";

export interface LogoInfo {
  /** Natural pixel size (used for the crop maths). */
  width: number;
  height: number;
  /** Tight box around the artwork, normalised to [0,1] of the natural size. */
  box: { x: number; y: number; w: number; h: number };
  kind: PlateKind;
  /** CSS colour painted behind the artwork. */
  plate: string;
  /** True when the artwork is light-on-dark (drives the tile's border tint). */
  lightInk: boolean;
}

/* Plate colours. Deliberately not pure #fff/#000: a hair off full white keeps
   the tile from glaring against the overlay, and a hair off black keeps a black
   logo's own card from disappearing into the panel. */
const LIGHT_PLATE = "#eef1f5";
const DARK_PLATE = "#0e1218";

/** Longest edge of the analysis bitmap. Plenty for luminance + a bounding box. */
const SAMPLE_MAX = 128;
/** Alpha (0-255) above which a pixel counts as drawn at all. */
const ALPHA_INK = 24;
/** Per-channel distance from the background before a pixel counts as ink. */
const BG_TOLERANCE = 46;

function luminance(r: number, g: number, b: number): number {
  // Rec. 709 relative luminance, on 0..1. Perceptual enough for a dark/light call.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Filename escape hatch: `logo@dark.png` forces a plate when detection is wrong. */
function forcedKind(src: string): PlateKind | null {
  const name = decodeURIComponent(src.split("/").pop() ?? "").toLowerCase();
  if (/@dark\.[a-z0-9]+$/.test(name)) return "dark";
  if (/@light\.[a-z0-9]+$/.test(name)) return "light";
  if (/@self\.[a-z0-9]+$/.test(name)) return "self";
  return null;
}

const FULL_BOX = { x: 0, y: 0, w: 1, h: 1 };

function fallback(img: HTMLImageElement, kind: PlateKind = "light"): LogoInfo {
  return {
    width: img.naturalWidth || 300,
    height: img.naturalHeight || 150,
    box: FULL_BOX,
    kind,
    plate: kind === "dark" ? DARK_PLATE : LIGHT_PLATE,
    lightInk: kind === "dark",
  };
}

function analyze(img: HTMLImageElement): LogoInfo {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const forced = forcedKind(img.src);
  if (!nw || !nh) return fallback(img, forced ?? "light");

  const scale = Math.min(1, SAMPLE_MAX / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback(img, forced ?? "light");

  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return fallback(img, forced ?? "light"); // tainted canvas — shouldn't happen same-origin
  }

  const at = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]] as const;
  };

  // --- transparent or self-backgrounded?
  // Decided by scanning every pixel, not by sampling corners: plenty of logos
  // bleed their artwork right to the edge (iFlight's wordmark touches both
  // sides), which makes any corner test report the ink as the background.
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) { hasAlpha = true; break; }
  }

  // --- background colour, for opaque images only.
  // Take the *modal* colour of the border ring rather than a mean. A mean is
  // dragged toward mid-grey whenever artwork touches an edge (RFDesign's black
  // panel runs the full width against a white card, averaging to grey); the mode
  // still lands on the card colour as long as most of the ring is card.
  let bgR = 0, bgG = 0, bgB = 0, bgShare = 0;
  if (!hasAlpha) {
    const counts = new Map<number, number>();
    const ring: Array<readonly [number, number, number, number]> = [];
    const edge = Math.min(2, Math.floor(Math.min(w, h) / 2));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= edge && x < w - edge && y >= edge && y < h - edge) continue;
        const px = at(x, y);
        ring.push(px);
        // 5 bits/channel: tight enough to separate white from black, loose
        // enough that JPEG noise across a flat card lands in one bucket.
        const key = ((px[0] >> 3) << 10) | ((px[1] >> 3) << 5) | (px[2] >> 3);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    let bestKey = -1, bestCount = 0;
    for (const [key, count] of counts) {
      if (count > bestCount) { bestCount = count; bestKey = key; }
    }
    bgShare = ring.length ? bestCount / ring.length : 0;
    let n = 0;
    for (const px of ring) {
      const key = ((px[0] >> 3) << 10) | ((px[1] >> 3) << 5) | (px[2] >> 3);
      if (key !== bestKey) continue;
      bgR += px[0]; bgG += px[1]; bgB += px[2]; n++;
    }
    if (n) { bgR /= n; bgG /= n; bgB /= n; }
  }
  // Below this the border is too varied to be a flat card (a photo, a gradient,
  // a full-bleed illustration) — nothing to crop against, so keep it whole.
  const uniformBg = !hasAlpha && bgShare > 0.55;

  // --- ink mask: bounding box + mean luminance of everything that isn't background.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  let lumSum = 0, lumWeight = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = at(x, y);
      if (a < ALPHA_INK) continue;
      if (uniformBg) {
        const dist = Math.max(Math.abs(r - bgR), Math.abs(g - bgG), Math.abs(b - bgB));
        if (dist < BG_TOLERANCE) continue;
      }
      const weight = a / 255;
      lumSum += luminance(r, g, b) * weight;
      lumWeight += weight;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // Nothing found (blank or near-uniform image): show it whole, plate it light.
  const inkFraction = lumWeight / (w * h);
  if (maxX < 0 || inkFraction < 0.001) return fallback(img, forced ?? "light");

  const box = {
    x: minX / w,
    y: minY / h,
    w: (maxX - minX + 1) / w,
    h: (maxY - minY + 1) / h,
  };
  const inkLum = lumSum / lumWeight;

  // --- plate choice.
  let kind: PlateKind;
  if (forced) {
    kind = forced;
  } else if (!hasAlpha) {
    // The image brought its own background. Reuse that exact colour for the tile
    // so the letterboxing around the fit is seamless — no rectangle, no halo.
    // (Busy/full-bleed images land here too; they just aren't cropped.)
    kind = "self";
  } else {
    // Transparent artwork: pick whichever plate its ink contrasts against. The
    // threshold sits above 0.5 because mid-tone brand colours (ANSYS orange,
    // iFlight red) read better on light than on dark.
    kind = inkLum > 0.62 ? "dark" : "light";
  }

  const plate = kind === "self"
    ? `rgb(${Math.round(bgR)}, ${Math.round(bgG)}, ${Math.round(bgB)})`
    : kind === "dark" ? DARK_PLATE : LIGHT_PLATE;

  return {
    width: nw,
    height: nh,
    box,
    kind,
    plate,
    lightInk: kind === "dark" || (kind === "self" && luminance(bgR, bgG, bgB) < 0.4),
  };
}

const cache = new Map<string, Promise<LogoInfo>>();

/** Analyse a logo once per URL; repeated mounts reuse the result. */
export function loadLogo(src: string): Promise<LogoInfo> {
  const hit = cache.get(src);
  if (hit) return hit;
  const p = new Promise<LogoInfo>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(analyze(img));
    img.onerror = () => resolve(fallback(img, "light"));
    img.src = src;
  });
  cache.set(src, p);
  return p;
}

/**
 * Place a logo inside a tile: crop the baked-in padding, then normalise optical
 * size so a wide wordmark and a square badge carry similar visual weight.
 *
 * Fitting the content box alone isn't enough — a 5:1 wordmark fitted to a square
 * tile is width-limited and ends up covering far less area than a square badge
 * that is height-limited, so the badge shouts. We fit first, then scale toward a
 * common target *area*, clamped so nothing overflows (>1) or vanishes (<0.7).
 */
export function fitLogo(
  info: LogoInfo,
  boxW: number,
  boxH: number,
): { width: number; height: number; left: number; top: number } {
  const contentW = Math.max(1, info.box.w * info.width);
  const contentH = Math.max(1, info.box.h * info.height);
  const fit = Math.min(boxW / contentW, boxH / contentH);

  const fittedArea = contentW * fit * contentH * fit;
  const targetArea = boxW * boxH * 0.5;
  const balance = Math.min(1, Math.max(0.7, Math.sqrt(targetArea / Math.max(1, fittedArea))));
  const scale = fit * balance;

  const width = info.width * scale;
  const height = info.height * scale;
  return {
    width,
    height,
    // Centre the *content* box in the tile, not the image — that's what removes
    // asymmetric padding (a logo with empty space only on its right, say).
    left: boxW / 2 - (info.box.x + info.box.w / 2) * width,
    top: boxH / 2 - (info.box.y + info.box.h / 2) * height,
  };
}
