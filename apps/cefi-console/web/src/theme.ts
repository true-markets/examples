import { useEffect, useState } from "react";

// Light, dark, or follow the OS. The choice is saved in this browser; index.html applies it before
// the first paint, and this keeps <html data-theme> in step afterwards.
export type Theme = "light" | "dark" | "system";

const KEY = "cefi-console:theme";

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // not remembered
    }
  }, [theme]);
  return [theme, setTheme];
}
