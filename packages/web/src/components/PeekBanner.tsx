"use client";

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";

type PeekBannerProps = {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  peekDelay?: number;
  /** Height in px visible when the banner is in peek (collapsed) mode. */
  peekHeight?: number;
  className?: string;
};

export function PeekBanner({
  children,
  open,
  onClose,
  peekDelay = 3000,
  peekHeight = 36,
  className = "",
}: PeekBannerProps) {
  const [visible, setVisible] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false); // true when user manually expanded
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  // Open/close
  useEffect(() => {
    if (open) {
      setVisible(true);
      setPeeking(false);
      setUserExpanded(false);
    } else {
      setVisible(false);
      setPeeking(false);
      setUserExpanded(false);
      clearTimer();
    }
  }, [open, clearTimer]);

  // Auto-peek after delay (only if not user-expanded)
  useEffect(() => {
    if (visible && !peeking && !userExpanded) {
      clearTimer();
      timerRef.current = setTimeout(() => setPeeking(true), peekDelay);
      return clearTimer;
    }
  }, [visible, peeking, userExpanded, peekDelay, clearTimer]);

  const handleExpand = useCallback(() => {
    clearTimer();
    setPeeking(false);
    setUserExpanded(true); // User action — stay expanded indefinitely
  }, [clearTimer]);

  const handleCollapse = useCallback(() => {
    setPeeking(true);
    setUserExpanded(false);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setPeeking(false);
    setUserExpanded(false);
    clearTimer();
    onClose();
  }, [clearTimer, onClose]);

  // Compute transform — peek mode slides the content down so only
  // the first peekHeight pixels are visible above the bottom edge.
  let translateY: string;
  if (!visible) {
    translateY = "calc(100% + 8px)";
  } else if (peeking) {
    translateY = `calc(100% - ${peekHeight}px)`;
  } else {
    translateY = "0";
  }

  return (
    <div className={className}>
      <div
        style={{
          transform: `translateY(${translateY})`,
          transition: "transform 350ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms ease",
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? "auto" : "none",
        }}
        className="will-change-transform"
      >
      <div className="relative">
        {/* Close button */}
        <button
          onClick={handleClose}
          className="absolute top-1.5 right-1.5 p-1 rounded-md text-white/30 hover:text-white/70 hover:bg-white/[0.08] transition-colors cursor-pointer z-10"
          title="Dismiss"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Expand button (peek mode) or Collapse button (user-expanded mode) */}
        {peeking && (
          <button
            onClick={handleExpand}
            className="absolute top-1.5 right-8 p-1 rounded-md text-white/30 hover:text-white/70 hover:bg-white/[0.08] transition-colors cursor-pointer z-10"
            title="Show details"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>
        )}
        {userExpanded && (
          <button
            onClick={handleCollapse}
            className="absolute top-1.5 right-8 p-1 rounded-md text-white/30 hover:text-white/70 hover:bg-white/[0.08] transition-colors cursor-pointer z-10"
            title="Collapse"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}

        {children}
      </div>
      </div>
    </div>
  );
}
