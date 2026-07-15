// Compact, self-contained legend chip overlaid on a plot (altitude chart, GPS
// map). Each item is a line swatch (solid/dashed) or a dot, with a label.
export interface LegendItem {
  label: string;
  color: string;
  dash?: boolean; // dashed line swatch (matches a dashed series)
  dot?: boolean;  // filled dot swatch instead of a line (matches a point marker)
}

type Corner = "tl" | "tr" | "bl" | "br";

const CORNER: Record<Corner, React.CSSProperties> = {
  tl: { top: 4, left: 8 },
  tr: { top: 4, right: 8 },
  bl: { bottom: 4, left: 8 },
  br: { bottom: 4, right: 8 },
};

export function PlotLegend({ items, corner = "tl" }: { items: LegendItem[]; corner?: Corner }) {
  return (
    <div className="plot-legend" style={{ position: "absolute", zIndex: 2, ...CORNER[corner] }}>
      {items.map((it) => (
        <span key={it.label} className="plot-legend-item">
          {it.dot ? (
            <span className="plot-legend-dot" style={{ background: it.color }} />
          ) : (
            <span
              className="plot-legend-swatch"
              style={{ borderTopColor: it.color, borderTopStyle: it.dash ? "dashed" : "solid" }}
            />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}
