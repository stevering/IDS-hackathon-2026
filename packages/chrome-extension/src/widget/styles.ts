/**
 * Shadow DOM styles for the Guardian floating widget.
 *
 * Uses CSS individual transform properties (translate, scale) so that
 * the float animation and the hover scale don't conflict on `transform`.
 */
export function getWidgetStyles(): string {
  return /* css */ `
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    /* ── Wrapper: the fixed overlay anchor ── */
    .wrapper {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      width: 72px;
      height: 72px;
      cursor: pointer;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
      outline: none;
    }

    /* ── Mascot: holds the SVG and float animation ── */
    .mascot {
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 4px 20px rgba(109, 40, 217, 0.35));
      transition: scale 0.25s ease, filter 0.25s ease, opacity 0.25s ease;
      animation: guardian-float 3s ease-in-out infinite;
    }

    .wrapper:hover .mascot {
      scale: 1.12;
      filter: drop-shadow(0 6px 28px rgba(109, 40, 217, 0.65));
      animation-play-state: paused;
    }

    .wrapper:focus-visible .mascot {
      filter: drop-shadow(0 0 0 3px #A78BFA) drop-shadow(0 4px 20px rgba(109, 40, 217, 0.5));
    }

    /* ── Minimized state ── */
    .wrapper.minimized .mascot {
      scale: 0.55;
      opacity: 0.6;
      translate: 18px 18px;
      animation-play-state: paused;
      filter: drop-shadow(0 2px 8px rgba(109, 40, 217, 0.2));
    }

    /* ── Animations ── */

    @keyframes guardian-float {
      0%, 100% { translate: 0 0px; }
      50%       { translate: 0 -9px; }
    }

    /* Eye blink: groups scale on Y axis around their own center */
    .eye-left,
    .eye-right {
      transform-box: fill-box;
      transform-origin: center;
      animation: guardian-blink 4.5s ease-in-out infinite;
    }

    .eye-right {
      animation-delay: 0.08s;
    }

    @keyframes guardian-blink {
      0%, 88%, 100% { transform: scaleY(1); }
      92%           { transform: scaleY(0.07); }
    }

    /* G-arc breathing */
    .guardian-arc {
      animation: guardian-breathe 4s ease-in-out infinite;
    }

    @keyframes guardian-breathe {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.78; }
    }

    /* Star badge twinkle */
    .guardian-star {
      transform-box: fill-box;
      transform-origin: center;
      animation: guardian-twinkle 2.8s ease-in-out infinite;
    }

    @keyframes guardian-twinkle {
      0%, 100% { transform: scale(1);   opacity: 0.92; }
      50%       { transform: scale(1.3); opacity: 1;    }
    }
  `;
}
