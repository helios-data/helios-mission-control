import type { ReactNode } from "react";

export function Panel({
  title, children, right, className = "", corner = true,
}: {
  title?: string;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
  corner?: boolean;
}) {
  return (
    <section className={`panel ${corner ? "panel-corner" : ""} ${className}`}>
      {title && (
        <h2 className="panel-title">
          <span>{title}</span>
          {right && <span style={{ marginLeft: "auto" }}>{right}</span>}
        </h2>
      )}
      {children}
    </section>
  );
}
