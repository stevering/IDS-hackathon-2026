"use client";

import { useEffect } from "react";

const DARK_BG = "#0a0a0a";
const LIGHT_BG = "#fafafa";

export function ThemeSync() {
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (!e.data || e.data.type !== "set-theme") return;
      const theme: "dark" | "light" = e.data.theme === "light" ? "light" : "dark";
      const isLight = theme === "light";

      document.documentElement.classList.toggle("theme-light", isLight);
      document.documentElement.style.background = isLight ? LIGHT_BG : DARK_BG;
      document.documentElement.style.colorScheme = isLight ? "light" : "dark";
      document.body.style.background = isLight ? LIGHT_BG : DARK_BG;
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}
