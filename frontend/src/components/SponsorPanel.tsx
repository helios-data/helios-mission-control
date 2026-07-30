import { useEffect, useState } from "react";
import { LogoPlate } from "./LogoPlate";

export interface SponsorSection {
  name: string;
  logos: string[];
}

/** Fetch the rotation sections served from the linked /app/sponsorships volume. */
export function useSponsors(): SponsorSection[] {
  const [sections, setSections] = useState<SponsorSection[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/sponsors")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no sponsors"))))
      .then((d) => {
        const list: SponsorSection[] = (d?.sections ?? []).filter(
          (s: SponsorSection) => s.logos?.length,
        );
        if (live) setSections(list);
      })
      .catch(() => { /* no sponsor volume linked — panel stays hidden */ });
    return () => { live = false; };
  }, []);
  return sections;
}

/** Cross-fade duration; must match the .sponsor-grid transition in overlay.css. */
const FADE_MS = 450;

/**
 * Rotating sponsor wall. Shows one section (one subfolder) at a time and cycles
 * through them, cross-fading so nothing pops on a broadcast feed.
 *
 * The grid column count adapts to the section size, but the panel height is
 * fixed by CSS — a section with three logos and one with six must occupy exactly
 * the same box, or the whole right column would reflow every rotation.
 */
export function SponsorPanel({ sections, intervalS = 10 }: {
  sections: SponsorSection[];
  intervalS?: number;
}) {
  const [idx, setIdx] = useState(0);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (sections.length < 2) { setIdx(0); return; }
    const period = Math.max(3, intervalS) * 1000;
    const id = setInterval(() => {
      setShown(false);
      setTimeout(() => {
        setIdx((i) => (i + 1) % sections.length);
        setShown(true);
      }, FADE_MS);
    }, period);
    return () => clearInterval(id);
  }, [sections.length, intervalS]);

  if (!sections.length) return null;
  const section = sections[Math.min(idx, sections.length - 1)];
  const n = section.logos.length;
  const cols = n <= 2 ? 1 : n <= 8 ? 2 : 3;

  return (
    <>
      <div
        className="sponsor-grid"
        data-cols={cols}
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, opacity: shown ? 1 : 0 }}
      >
        {section.logos.map((src) => (
          <LogoPlate key={src} src={src} alt="" />
        ))}
      </div>
      {sections.length > 1 && (
        <div className="sponsor-dots" aria-hidden>
          {sections.map((s, i) => (
            <span key={s.name} className={i === idx ? "on" : ""} />
          ))}
        </div>
      )}
    </>
  );
}
