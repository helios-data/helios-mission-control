import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "hmc-theme";

export function getInitialTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  return saved === "light" ? "light" : "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

// Set the attribute ASAP (called from entry before React renders) to avoid a
// flash of the wrong theme.
export function initThemeEarly(): void {
  applyTheme(getInitialTheme());
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);
  return [theme, () => setTheme((p) => (p === "dark" ? "light" : "dark"))];
}
