import { setEditorTheme } from "../editor/monaco";

export type Theme = "dark" | "light";

const LS_KEY = "rtl-viewer.theme";
let systemTheme: MediaQueryList | undefined;

function onSystemTheme(event: MediaQueryListEvent): void {
  const saved = localStorage.getItem(LS_KEY);
  if (saved !== "light" && saved !== "dark") apply(event.matches ? "light" : "dark");
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  setEditorTheme(theme);
}

export function initTheme(): void {
  systemTheme?.removeEventListener("change", onSystemTheme);
  systemTheme = window.matchMedia("(prefers-color-scheme: light)");
  systemTheme.addEventListener("change", onSystemTheme);
  const saved = localStorage.getItem(LS_KEY);
  const theme: Theme =
    saved === "light" || saved === "dark"
      ? saved
      : systemTheme.matches
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
