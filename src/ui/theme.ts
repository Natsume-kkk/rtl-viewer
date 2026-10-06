import { setEditorTheme } from "../editor/monaco";

export type Theme = "dark" | "light";

const LS_KEY = "rtl-viewer.theme";

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  setEditorTheme(theme);
}

export function initTheme(): void {
  const saved = localStorage.getItem(LS_KEY);
  const theme: Theme =
    saved === "light" || saved === "dark"
      ? saved
      : window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  apply(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(LS_KEY, next);
  apply(next);
  return next;
}
