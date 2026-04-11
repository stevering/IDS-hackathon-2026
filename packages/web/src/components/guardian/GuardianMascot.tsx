"use client";

/**
 * GuardianMascot — the animated Guardian character as an SVG.
 *
 * Runs four independent animation CHANNELS in parallel on the same SVG:
 *   - body   → whole-character transforms (bounce, tilt, jelly, twist, melt…)
 *   - eyes   → blink, double blink, wink, look around, eyes wide
 *   - ears   → wiggle (each ear pivots from its base), perk up
 *   - star   → the little insignia rotates / twinkles
 *
 * Because each channel targets DIFFERENT elements (root vs .eye-* vs .hear-*
 * vs .guardian-star), their CSS transforms compose rather than override each
 * other — the character can blink while its body is twisting while its ears
 * wiggle while the star sparkles, all independently timed.
 *
 * Classes added to the SVG root are picked up by matching rules in globals.css
 * (see the "Guardian mascot" section). See also:
 *   - packages/web/public/guardian-logo.svg  (the original asset)
 *   - docs/architecture/chat-ui.md            (architectural notes)
 */

import { useEffect, useRef } from "react";

type AnimDesc = { cls: string; duration: number };

// Whole-body animations (applied to the <svg> root).
const BODY_ANIMS: AnimDesc[] = [
  { cls: "anim-bounce", duration: 1600 },
  { cls: "anim-tilt", duration: 2000 },
  { cls: "anim-breath", duration: 2400 },
  { cls: "anim-wiggle", duration: 2000 },
  { cls: "anim-nod", duration: 1600 },
  { cls: "anim-stretch", duration: 1400 },
  { cls: "anim-squish", duration: 1000 },
  { cls: "anim-jelly", duration: 1800 },
  { cls: "anim-twist", duration: 1600 },
  { cls: "anim-twist3d", duration: 2200 },
  { cls: "anim-swirl", duration: 2000 },
  { cls: "anim-surprise", duration: 1300 },
  { cls: "anim-wobble", duration: 1600 },
  { cls: "anim-stretchy", duration: 1500 },
  { cls: "anim-shiver", duration: 600 },
  { cls: "anim-melt", duration: 2000 },
  { cls: "anim-pop", duration: 900 },
  { cls: "anim-excited", duration: 1000 },
  { cls: "anim-think", duration: 2500 },
  { cls: "anim-lean", duration: 1800 },
];

// Eye-only animations. `anim-blink` is listed twice so simple blinks are twice
// as likely to be picked (matches natural human blinking cadence).
const EYES_ANIMS: AnimDesc[] = [
  { cls: "anim-blink", duration: 450 },
  { cls: "anim-blink", duration: 450 },
  { cls: "anim-doubleblink", duration: 900 },
  { cls: "anim-look", duration: 2400 },
  { cls: "anim-winkleft", duration: 600 },
  { cls: "anim-winkright", duration: 600 },
  { cls: "anim-eyeswide", duration: 1200 },
];

const EARS_ANIMS: AnimDesc[] = [
  { cls: "anim-ears", duration: 1200 },
  { cls: "anim-earsperk", duration: 800 },
];

const STAR_ANIMS: AnimDesc[] = [
  { cls: "anim-star", duration: 1400 },
  { cls: "anim-startwinkle", duration: 900 },
];

/**
 * Starts a single animation channel on an SVG element. Returns a cleanup
 * function that stops the channel and removes any pending class it added.
 */
function startChannel(
  el: SVGSVGElement,
  pool: AnimDesc[],
  minPause: number,
  maxPause: number,
): () => void {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const tick = () => {
    if (stopped) return;
    // Remove only classes owned by THIS channel's pool.
    for (const p of pool) el.classList.remove(p.cls);
    // Force reflow so the same class can re-trigger if it's picked again.
    void el.getBoundingClientRect();
    const anim = pool[Math.floor(Math.random() * pool.length)];
    el.classList.add(anim.cls);
    timeoutId = setTimeout(() => {
      if (stopped) return;
      el.classList.remove(anim.cls);
      const pause = minPause + Math.random() * (maxPause - minPause);
      timeoutId = setTimeout(tick, pause);
    }, anim.duration);
  };
  tick();

  return () => {
    stopped = true;
    if (timeoutId) clearTimeout(timeoutId);
    for (const p of pool) el.classList.remove(p.cls);
  };
}

type GuardianMascotProps = {
  /** Rendered size in pixels (the SVG is square). Default: 42. */
  size?: number;
  /** When true, no animations run and the character is frozen. Default: false. */
  paused?: boolean;
  /** Extra class names appended to the SVG's class list. */
  className?: string;
};

export function GuardianMascot({
  size = 42,
  paused = false,
  className = "",
}: GuardianMascotProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (paused) return;
    const svg = svgRef.current;
    if (!svg) return;

    const initialTimers: ReturnType<typeof setTimeout>[] = [];
    const cleanups: Array<() => void> = [];

    // Stagger the initial start of each channel so they don't fire in lockstep
    // on mount — the character feels more natural when the channels drift.
    const schedule = (
      pool: AnimDesc[],
      minPause: number,
      maxPause: number,
      initialDelayMax: number,
    ) => {
      const t = setTimeout(() => {
        cleanups.push(startChannel(svg, pool, minPause, maxPause));
      }, Math.random() * initialDelayMax);
      initialTimers.push(t);
    };

    schedule(BODY_ANIMS, 300, 1200, 400);
    schedule(EYES_ANIMS, 600, 2200, 1500);
    schedule(EARS_ANIMS, 1800, 4500, 3000);
    schedule(STAR_ANIMS, 1500, 3500, 2500);

    return () => {
      for (const t of initialTimers) clearTimeout(t);
      for (const c of cleanups) c();
    };
  }, [paused]);

  return (
    <svg
      ref={svgRef}
      className={`guardian-mascot ${className}`.trim()}
      width={size}
      height={size}
      viewBox="-18 -4 136 128"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* G-arc body + horizontal bar */}
      <path
        className="guardian-arc"
        d="M 81 34 A 42 42 0 1 0 81 94"
        fill="none"
        stroke="#6D28D9"
        strokeWidth="19"
        strokeLinecap="round"
      />
      <path
        className="guardian-arc"
        d="M 72 80 L 93 80"
        fill="none"
        stroke="#6D28D9"
        strokeWidth="15"
        strokeLinecap="round"
      />
      {/* Light reflex on the arc (friendly 3D feel) */}
      <path
        d="M 76 37 A 37 37 0 1 0 76 91"
        fill="none"
        stroke="#A78BFA"
        strokeWidth="5"
        strokeLinecap="round"
        opacity="0.45"
      />
      {/* Rounded ears on top of the arc */}
      <g className="hear-left">
        <ellipse cx="21" cy="27" rx="10" ry="13" fill="#6D28D9" />
        <ellipse cx="21" cy="28" rx="6" ry="8" fill="#DDD6FE" opacity="0.75" />
      </g>
      <g className="hear-right">
        <ellipse cx="81" cy="27" rx="10" ry="13" fill="#6D28D9" />
        <ellipse cx="81" cy="28" rx="6" ry="8" fill="#DDD6FE" opacity="0.75" />
      </g>
      {/* Eyebrows */}
      <path
        d="M 31 44 Q 40 40 49 43"
        fill="none"
        stroke="#4C1D95"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M 55 43 Q 64 40 73 44"
        fill="none"
        stroke="#4C1D95"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* Eyeball whites (stay fixed; pupils move inside during look animation) */}
      <ellipse cx="40" cy="52" rx="8" ry="9" fill="white" />
      <ellipse cx="64" cy="52" rx="8" ry="9" fill="white" />
      {/* Pupils + highlights — grouped so blink / wink / look can target them */}
      <g className="eye-left">
        <ellipse cx="40" cy="53.5" rx="5.5" ry="6.5" fill="#2E1065" />
        <circle cx="42" cy="51" r="2.2" fill="white" />
        <circle cx="38.5" cy="55" r="1" fill="white" opacity="0.6" />
      </g>
      <g className="eye-right">
        <ellipse cx="64" cy="53.5" rx="5.5" ry="6.5" fill="#2E1065" />
        <circle cx="66" cy="51" r="2.2" fill="white" />
        <circle cx="62.5" cy="55" r="1" fill="white" opacity="0.6" />
      </g>
      {/* Warm smile */}
      <path
        d="M 32 64 Q 52 78 72 64"
        fill="none"
        stroke="#4C1D95"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      {/* Blush */}
      <ellipse cx="29" cy="63" rx="8" ry="4.5" fill="#C4B5FD" opacity="0.2" />
      <ellipse cx="75" cy="63" rx="8" ry="4.5" fill="#C4B5FD" opacity="0.2" />
      {/* Star insignia */}
      <path
        className="guardian-star"
        d="M 87 73 L 88.3 77.7 L 93 79 L 88.3 80.3 L 87 85 L 85.7 80.3 L 81 79 L 85.7 77.7 Z"
        fill="white"
        opacity="0.92"
      />
      {/* Small arms poking out */}
      <ellipse
        cx="14"
        cy="67"
        rx="6"
        ry="9"
        fill="#6D28D9"
        transform="rotate(-25 14 67)"
      />
      <ellipse
        cx="90"
        cy="97"
        rx="6"
        ry="9"
        fill="#6D28D9"
        transform="rotate(15 90 97)"
      />
    </svg>
  );
}
