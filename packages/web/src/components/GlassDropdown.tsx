"use client";

import { useRef, useEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type GlassDropdownProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  side?: "top" | "bottom";
  align?: "left" | "right";
  width?: number | "anchor";
  children: ReactNode;
};

export function GlassDropdown({
  open,
  onClose,
  anchorRef,
  side = "bottom",
  align = "left",
  width = "anchor",
  children,
}: GlassDropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // Compute position from anchor
  useEffect(() => {
    if (!open || !anchorRef.current) {
      setPos(null);
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    const w = width === "anchor" ? rect.width : width;
    setPos({
      top: side === "bottom" ? rect.bottom + 4 : rect.top - 4,
      left: align === "left" ? rect.left : rect.right - w,
      width: w,
    });
  }, [open, anchorRef, side, align, width]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        anchorRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[9999] rounded-lg border border-white/15 overflow-hidden"
      style={{
        top: pos.top,
        left: pos.left,
        width: pos.width,
        transform: side === "top" ? "translateY(-100%)" : undefined,
        background: "rgba(10,10,10,0.5)",
        backdropFilter: "blur(20px) saturate(1.5)",
        WebkitBackdropFilter: "blur(20px) saturate(1.5)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
      }}
    >
      {children}
    </div>,
    document.body
  );
}
