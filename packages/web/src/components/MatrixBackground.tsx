"use client";

import { useEffect, useState } from "react";
import { MatrixConsciousness } from "./MatrixConsciousness";

/** Reads localStorage and renders the Matrix background if enabled. */
export function MatrixBackground() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(localStorage.getItem("guardian_matrix") === "1");

    // Listen for changes from the account page toggle
    const handler = (e: StorageEvent) => {
      if (e.key === "guardian_matrix") {
        setEnabled(e.newValue === "1");
      }
    };
    window.addEventListener("storage", handler);

    // Also listen for custom event (same-tab updates)
    const custom = () => setEnabled(localStorage.getItem("guardian_matrix") === "1");
    window.addEventListener("guardian_matrix_toggle", custom);

    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("guardian_matrix_toggle", custom);
    };
  }, []);

  if (!enabled) return null;
  return <MatrixConsciousness />;
}
