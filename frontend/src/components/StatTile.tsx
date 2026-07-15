export function StatTile({
  label, value, unit, sub, size = 22, color, stale = false,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  size?: number;
  color?: string;
  stale?: boolean;
}) {
  return (
    <div className={`stat ${stale ? "stale" : ""}`}>
      <span className="label">{label}</span>
      <span className="value" style={{ fontSize: size, color }}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </span>
      {sub && <span className="faint mono" style={{ fontSize: 11 }}>{sub}</span>}
    </div>
  );
}
