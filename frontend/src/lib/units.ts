// Formatting + unit helpers. Conversions mirror the backend (constants.py).

export const M_TO_FT = 3.280839895;

export function fmt(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString();
}

export function meters(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined ? "—" : `${fmt(n, digits)} m`;
}

export function feet(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined ? "—" : `${fmt(n * M_TO_FT, digits)} ft`;
}

export function fmtLatLon(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toFixed(6);
}

// mm:ss / T+mm:ss clock formatting from seconds.
export function clock(seconds: number | null | undefined, sign = false): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "--:--";
  const neg = seconds < 0;
  const s = Math.abs(seconds);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const body = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  if (!sign) return body;
  return `${neg ? "T-" : "T+"}${body}`;
}

export function ageLabel(ageS: number | null | undefined): string {
  if (ageS === null || ageS === undefined) return "—";
  if (ageS < 1) return "now";
  return clock(ageS) + " ago";
}

// Great-circle distance (m) and initial bearing (deg) between two lat/lon.
export function haversine(
  lat1: number, lon1: number, lat2: number, lon2: number,
): { distance: number; bearing: number } {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1), dλ = toRad(lon2 - lon1);
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const distance = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return { distance, bearing: (bearing + 360) % 360 };
}
