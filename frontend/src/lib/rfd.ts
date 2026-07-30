// RFD900x ground-modem configuration: the set of values the admin Configuration
// tab will accept for an `rfd_config` command.
//
// Field keys must match falcon-protos `RfdConfig` exactly — `helios_bridge`
// filters the payload down to real proto fields, so a typo here silently
// no-ops instead of erroring. Mirrored server-side in `src/constants.py`
// (RFD_FIELDS); keep the two in sync.

// S4 is entered and stored in whole dBm, but this radio is spec'd and talked
// about in watts ("the 1 W radio"), so the equivalent power is shown alongside.
export const dbmToWatts = (dbm: number): number => 10 ** (dbm / 10) / 1000;

/**
 * Watt reading for a dBm register. Fixed to 3 decimals: the whole usable range
 * is 0.001–1 W, so trimming would collapse most of it ("0.01" vs "0.010").
 */
export function formatWatts(watts: number): string {
  return `${watts.toFixed(3)} W`;
}

export type RfdFieldSpec = {
  key: string;
  label: string;
  reg: string; // S-register the value is written to
  unit: string;
  hint?: string;
} & (
  | { kind: "enum"; values: number[] }
  // `display: "watts"` shows the entered dBm converted to watts beside the
  // input. Entry, min/max and the value sent all stay in dBm.
  | { kind: "range"; min: number; max: number; display?: "watts" }
);

export const RFD_FIELDS: RfdFieldSpec[] = [
  {
    key: "min_freq_khz", label: "Min freq", reg: "S8", unit: "kHz",
    kind: "range", min: 902000, max: 927000,
    hint: "900 MHz ISM band lower edge",
  },
  {
    key: "max_freq_khz", label: "Max freq", reg: "S9", unit: "kHz",
    kind: "range", min: 903000, max: 928000,
    hint: "must be above min freq",
  },
  {
    key: "net_id", label: "Net ID", reg: "S3", unit: "",
    kind: "range", min: 0, max: 499,
    hint: "both modems must match",
  },
  {
    key: "tx_power_dbm", label: "TX power", reg: "S4", unit: "dBm",
    kind: "range", min: 0, max: 30, display: "watts",
    hint: "0–30 dBm (0.001–1 W)",
  },
  {
    // "One-byte form": the value is the rate in kbps, i.e. 64 -> 64000 bps.
    key: "air_speed_kbps", label: "Air speed", reg: "S2", unit: "kbps",
    kind: "enum", values: [12, 56, 64, 100, 125, 188, 200, 224, 500, 750],
    hint: "both modems must match",
  },
  {
    key: "num_channels", label: "Num channels", reg: "S10", unit: "",
    kind: "range", min: 1, max: 51,
    hint: "hopping channels across the band",
  },
];

export interface RfdValidation {
  /** Per-field message; any entry blocks EXECUTE. */
  errors: Record<string, string>;
  /** Advisory only — shown but does not block. */
  warnings: string[];
  /** Parsed numeric payload for the fields the operator actually filled in. */
  payload: Record<string, number>;
  valid: boolean;
  /** True when nothing was entered, so there is no command to send. */
  empty: boolean;
}

/**
 * Validate the raw form state. Keys map to the raw input strings; an empty
 * string means "leave this S-register alone" and is omitted from the payload
 * (RfdConfig fields are all `optional`, so a command can change one thing).
 */
export function validateRfd(raw: Record<string, string>): RfdValidation {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  const payload: Record<string, number> = {};

  for (const f of RFD_FIELDS) {
    const text = (raw[f.key] ?? "").trim();
    if (text === "") continue;

    const n = Number(text);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      errors[f.key] = "must be a whole number";
      continue;
    }
    if (f.kind === "range") {
      if (n < f.min || n > f.max) {
        errors[f.key] = `out of range — must be ${f.min}–${f.max}${f.unit ? ` ${f.unit}` : ""}`;
        continue;
      }
    } else if (!f.values.includes(n)) {
      errors[f.key] = `not a supported value — one of ${f.values.join(", ")}`;
      continue;
    }
    payload[f.key] = n;
  }

  // Cross-field: the band has to be a band.
  const lo = payload.min_freq_khz;
  const hi = payload.max_freq_khz;
  if (lo !== undefined && hi !== undefined && lo >= hi) {
    errors.max_freq_khz = "max freq must be above min freq";
  }

  if (payload.tx_power_dbm !== undefined && payload.tx_power_dbm >= 30) {
    warnings.push("TX power is at the 30 dBm (1 W) ceiling — confirm the launch site permits it.");
  }

  return {
    errors,
    warnings,
    payload,
    valid: Object.keys(errors).length === 0,
    empty: Object.keys(payload).length === 0,
  };
}
