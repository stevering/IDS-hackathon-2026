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

  // Close on outside wheel/scroll — ignore when inside the dropdown
  useEffect(() => {
    if (!open) return;
    function handleWheel(e: WheelEvent) {
      if (panelRef.current?.contains(e.target as Node)) {
        // Inside dropdown: find the scrollable list
        const scrollable = panelRef.current.querySelector("[class*='overflow-y']") as HTMLElement | null;
        if (scrollable && scrollable.contains(e.target as Node)) {
          // Wheel is on the scrollable list itself
          const { scrollTop, scrollHeight, clientHeight } = scrollable;
          const canScrollUp = scrollTop > 0;
          const canScrollDown = scrollTop + clientHeight < scrollHeight;
          if ((e.deltaY < 0 && canScrollUp) || (e.deltaY > 0 && canScrollDown)) return;
        }
        // Anywhere else in the panel (search, padding) or at scroll edges: block
        e.preventDefault();
        return;
      }
      // Outside dropdown: close
      onClose();
    }
    window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", handleWheel, true);
  }, [open, onClose]);

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
