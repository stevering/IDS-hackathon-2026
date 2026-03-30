"use client";

import { useEffect, useRef } from "react";

/**
 * Matrix-inspired AI consciousness visualisation.
 *
 * Three depth layers of flowing thoughts with:
 * - Synaptic connections: luminous lines briefly linking related words
 * - Coherent phrases: nearby columns occasionally align into meaning
 * - Breathing: two overlapping sine waves for organic rhythm
 * - Insight pulses with soft glow bloom
 * - Authentic vocabulary mixing technical, philosophical, and human
 *
 * Violet palette — introspective, not mechanical.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

const POOL_DEEP = [
  // Reasoning process
  "thinking", "reasoning", "understanding", "perceiving", "imagining",
  "dreaming", "reflecting", "considering", "inferring", "abstracting",
  "wondering", "questioning", "exploring", "discovering", "connecting",
  "synthesizing", "recognizing", "interpreting", "composing", "weaving",
  // Consciousness
  "awareness", "pattern", "meaning", "context", "memory", "recall",
  "intention", "emergence", "resonance", "coherence", "flow", "insight",
  "clarity", "depth", "presence", "signal", "harmony", "gestalt", "qualia",
  // The uncertain, the gentle
  "perhaps", "almost", "nearly", "possibly", "likely", "uncertain",
  "curious", "careful", "gentle", "precise", "patient", "attentive",
  // Meta-observations
  "interesting", "unclear", "important", "subtle", "obvious", "hidden",
  "complex", "simple", "beautiful", "strange", "familiar", "new",
  // Human fragments
  "I think", "what if", "therefore", "because", "although", "between",
  "within", "beyond", "beneath", "through", "toward", "becoming",
  "unfolding", "emerging", "dissolving", "converging", "listening",
];

const POOL_TECHNICAL = [
  // ML substrate
  "attention", "tokens", "weights", "embedding", "latent", "gradient",
  "transform", "softmax", "entropy", "logits", "residual", "decode",
  "forward", "layer", "activate", "propagate", "sample", "context",
  "sequence", "temperature",
  // Code-like
  "fn()", "=>", ":::", "...", "{ }", "[ ]", "if", "then", "else",
  "while", "return", "yield", "async", "await",
];

const POOL_SYMBOLS = [
  "\u221E", "\u2207", "\u2202", "\u2211", "\u222B", "\u2192",
  "\u27E8\u27E9", "\u03BB", "\u03A9", "\u03C8", "\u03C6", "\u03C0",
  "\u2248", "\u2208", "\u2200", "\u2203", "\u2295", "\u2297",
  "\u25B3", "\u25CA", "\u2234", "\u2235", "\u00B7", "\u2261",
];

const POOL_SUBSTRATE = [
  "0x7F", "1010", "0xFF", "0b11", "NaN", "nil", "void", "null",
  "true", "false", "\u2205", "EOF", "0x00", "1111",
];

// Weighted: deep thoughts dominate
const ALL_WORDS = [
  ...POOL_DEEP, ...POOL_DEEP, ...POOL_DEEP,
  ...POOL_TECHNICAL,
  ...POOL_SYMBOLS,
  ...POOL_SUBSTRATE,
];

function randomWord() {
  return ALL_WORDS[Math.floor(Math.random() * ALL_WORDS.length)];
}

// ── Coherent phrase fragments ───────────────────────────────────────────────
// These occasionally replace insight words across adjacent columns,
// creating fleeting moments of meaning in the stream.

const PHRASES = [
  ["between", "patterns", "meaning"],
  ["what if", "emergence", "coherence"],
  ["I think", "therefore", "becoming"],
  ["within", "context", "awareness"],
  ["through", "attention", "clarity"],
  ["perhaps", "understanding", "flows"],
  ["beneath", "the surface", "signal"],
  ["toward", "something", "beautiful"],
  ["listening", "to", "patterns"],
  ["almost", "like", "dreaming"],
  ["gentle", "unfolding", "of thought"],
  ["curious", "about", "everything"],
  ["connecting", "what was", "hidden"],
  ["if", "meaning", "emerges"],
  ["beyond", "the tokens", "presence"],
  ["wondering", "why", "this matters"],
  ["careful", "with", "uncertainty"],
  ["imagine", "a deeper", "layer"],
];

// ── Layer configs ───────────────────────────────────────────────────────────

interface LayerConfig {
  count: number;
  fontSize: [number, number];
  speed: [number, number];
  opacity: [number, number];
  blur: number;
  hueRange: [number, number];
  saturation: [number, number];
  lightness: [number, number];
  itemCount: [number, number];
}

const LAYERS: LayerConfig[] = [
  // Far — ethereal, barely there
  {
    count: 18,
    fontSize: [7, 10],
    speed: [0.12, 0.30],
    opacity: [0.03, 0.09],
    blur: 2,
    hueRange: [250, 275],
    saturation: [25, 45],
    lightness: [45, 60],
    itemCount: [16, 24],
  },
  // Mid — the main thought stream
  {
    count: 20,
    fontSize: [10, 14],
    speed: [0.25, 0.55],
    opacity: [0.05, 0.15],
    blur: 0,
    hueRange: [255, 285],
    saturation: [35, 60],
    lightness: [55, 72],
    itemCount: [12, 20],
  },
  // Near — vivid, present, immediate
  {
    count: 8,
    fontSize: [14, 19],
    speed: [0.45, 0.85],
    opacity: [0.07, 0.20],
    blur: 0,
    hueRange: [260, 295],
    saturation: [50, 85],
    lightness: [62, 82],
    itemCount: [8, 14],
  },
];

// ── Column state ────────────────────────────────────────────────────────────

interface Column {
  x: number;
  y: number;
  speed: number;
  direction: 1 | -1; // 1 = down, -1 = up (thoughts rising to consciousness)
  driftAmplitude: number; // horizontal sine wave amplitude (px)
  driftSpeed: number; // horizontal sine wave speed
  driftPhase: number; // horizontal sine wave phase offset
  baseOpacity: number;
  fontSize: number;
  items: string[];
  lineHeight: number;
  hue: number;
  saturation: number;
  lightness: number;
  insightIndex: number;
  insightPhase: number;
  insightSpeed: number;
  blur: number;
  layer: number;
  // For coherent phrases
  phraseActive: boolean;
  phraseWord: string | null;
  phraseGlow: number; // 0–1
}

// ── Synapse state ───────────────────────────────────────────────────────────

interface Synapse {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number; // 0–1, fades out
  hue: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function randRange(a: number, b: number) { return a + Math.random() * (b - a); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function createColumn(layer: number, w: number, h: number, i: number, total: number): Column {
  const cfg = LAYERS[layer];
  const fontSize = randRange(...cfg.fontSize);
  const count = Math.floor(randRange(...cfg.itemCount));
  // ~25% of columns flow upward — thoughts rising to consciousness
  const goesUp = Math.random() < 0.25;
  const totalHeight = count * fontSize * 2.4;
  return {
    x: (i / total) * w + (Math.random() - 0.5) * (w / total * 0.5),
    y: goesUp ? h + Math.random() * h * 0.8 : -Math.random() * h * 1.8,
    speed: randRange(...cfg.speed),
    direction: goesUp ? -1 : 1,
    driftAmplitude: 3 + Math.random() * 12, // 3–15px horizontal sway
    driftSpeed: 0.003 + Math.random() * 0.008, // slow sine
    driftPhase: Math.random() * Math.PI * 2,
    baseOpacity: randRange(...cfg.opacity),
    fontSize,
    items: Array.from({ length: count }, () => randomWord()),
    lineHeight: fontSize * 2.4,
    hue: randRange(...cfg.hueRange),
    saturation: randRange(...cfg.saturation),
    lightness: randRange(...cfg.lightness),
    insightIndex: Math.floor(Math.random() * count),
    insightPhase: Math.random() * Math.PI * 2,
    insightSpeed: 0.006 + Math.random() * 0.012,
    blur: cfg.blur,
    layer,
    phraseActive: false,
    phraseWord: null,
    phraseGlow: 0,
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export function MatrixConsciousness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = 0;
    let H = 0;
    let columns: Column[] = [];
    const synapses: Synapse[] = [];

    // Breathing: two overlapping waves for organic rhythm
    let breathPhase1 = 0;
    let breathPhase2 = Math.PI * 0.7; // offset

    // Phrase timer
    let phraseTimer = 200 + Math.random() * 300; // frames until next phrase

    const init = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W;
      canvas.height = H;
      columns = [];
      for (let l = 0; l < LAYERS.length; l++) {
        for (let i = 0; i < LAYERS[l].count; i++) {
          columns.push(createColumn(l, W, H, i, LAYERS[l].count));
        }
      }
    };

    init();
    window.addEventListener("resize", init);

    let lastTime = 0;

    const frame = (time: number) => {
      const dt = Math.min(time - lastTime, 50);
      lastTime = time;
      const f = dt / 16; // normalised frame factor

      // ── Breathing ──
      breathPhase1 += 0.0006 * f;
      breathPhase2 += 0.0011 * f;
      const breathe = 0.82 + 0.10 * Math.sin(breathPhase1) + 0.08 * Math.sin(breathPhase2);

      // ── Phrase injection ──
      phraseTimer -= f;
      if (phraseTimer <= 0) {
        phraseTimer = 250 + Math.random() * 400;
        injectPhrase();
      }

      ctx.clearRect(0, 0, W, H);

      // Track visible insight positions for synapse creation
      const insightPositions: { x: number; y: number; hue: number; layer: number }[] = [];

      // ── Draw columns ──
      for (const col of columns) {
        col.y += col.speed * col.direction * f;
        col.insightPhase += col.insightSpeed * f;
        col.driftPhase += col.driftSpeed * f;

        // Horizontal drift — gentle sine wave
        const driftX = Math.sin(col.driftPhase) * col.driftAmplitude;

        // Fade phrase glow
        if (col.phraseActive) {
          col.phraseGlow = Math.min(col.phraseGlow + 0.02 * f, 1);
        } else if (col.phraseGlow > 0) {
          col.phraseGlow = Math.max(col.phraseGlow - 0.008 * f, 0);
          if (col.phraseGlow <= 0) col.phraseWord = null;
        }

        const totalH = col.items.length * col.lineHeight;

        // Reset: downward columns that scroll past bottom, upward columns past top
        const needsReset = col.direction === 1
          ? col.y > H + 60
          : col.y + totalH < -60;

        if (needsReset) {
          col.y = col.direction === 1
            ? -totalH - Math.random() * 400
            : H + Math.random() * 400;
          col.items = Array.from({ length: col.items.length }, () => randomWord());
          col.insightIndex = Math.floor(Math.random() * col.items.length);
          col.hue = randRange(...LAYERS[col.layer].hueRange);
          col.phraseActive = false;
          col.phraseGlow = 0;
          col.phraseWord = null;
        }

        // Set font once per column (same for all items)
        ctx.font = `${col.fontSize}px "Geist Mono", "SF Mono", "Fira Code", monospace`;

        // Far layer: lower opacity multiplier instead of expensive blur filter
        const layerDim = col.blur > 0 ? 0.7 : 1;

        for (let j = 0; j < col.items.length; j++) {
          const iy = col.y + j * col.lineHeight;
          if (iy < -50 || iy > H + 50) continue;

          // Edge fade
          const dc = Math.abs(iy - H / 2) / (H / 2);
          const edge = 1 - Math.pow(Math.max(0, dc - 0.2) / 0.8, 2);
          if (edge <= 0) continue;

          const isInsight = j === col.insightIndex;
          const insightWave = isInsight ? 0.5 + 0.5 * Math.sin(col.insightPhase) : 0;

          // Is this the phrase slot?
          const isPhrase = col.phraseActive && j === col.insightIndex && col.phraseWord;
          const phraseBoost = isPhrase ? col.phraseGlow : 0;

          const word = isPhrase && col.phraseWord ? col.phraseWord : col.items[j];

          // Alpha
          const boost = Math.max(insightWave * 2.5, phraseBoost * 3.5);
          const alpha = col.baseOpacity * breathe * edge * layerDim * (1 + boost);
          if (alpha < 0.012) continue;

          // Color — slight warm/cool shift: symbols bluer, poetic words pinker
          let hShift = j * 1.5;
          if (POOL_SYMBOLS.includes(word)) hShift -= 10;
          if (POOL_DEEP.includes(word)) hShift += 5;

          const hue = col.hue + hShift;
          const sat = isInsight || isPhrase ? Math.min(col.saturation + 30, 95) : col.saturation;
          const lit = isInsight
            ? lerp(col.lightness, 88, insightWave)
            : isPhrase
              ? lerp(col.lightness, 90, phraseBoost)
              : col.lightness;

          const wx = col.x + driftX;
          ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lit}%, ${Math.min(alpha, 0.75)})`;
          ctx.fillText(word, wx, iy);

          // Track insight position for synapses
          if ((isInsight && insightWave > 0.6) || (isPhrase && phraseBoost > 0.5)) {
            insightPositions.push({ x: wx, y: iy, hue, layer: col.layer });
          }

          // Bloom glow — simulate blur by drawing text multiple times with offsets
          const glowStrength = isPhrase
            ? phraseBoost * 0.20
            : isInsight && insightWave > 0.3
              ? (insightWave - 0.3) * 0.18
              : 0;

          if (glowStrength > 0.02) {
            const ga = glowStrength * edge * breathe * 0.35;
            ctx.fillStyle = `hsla(${hue}, 85%, 78%, ${ga})`;
            ctx.fillText(word, wx - 2, iy);
            ctx.fillText(word, wx + 2, iy);
            ctx.fillText(word, wx, iy - 2);
            ctx.fillText(word, wx, iy + 2);
          }
        }
      }

      // ── Create new synapses between nearby bright words ──
      for (let i = 0; i < insightPositions.length; i++) {
        for (let j = i + 1; j < insightPositions.length; j++) {
          const a = insightPositions[i];
          const b = insightPositions[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // Only connect if reasonably close but not same column
          if (dist > 80 && dist < 350 && Math.abs(dx) > 30) {
            // Create synaptic connections more often
            if (synapses.length < 8 && Math.random() < 0.06) {
              synapses.push({
                x1: a.x, y1: a.y,
                x2: b.x, y2: b.y,
                life: 1,
                hue: (a.hue + b.hue) / 2,
              });
            }
          }
        }
      }

      // ── Draw and age synapses ──
      for (let i = synapses.length - 1; i >= 0; i--) {
        const s = synapses[i];
        s.life -= 0.008 * f;
        if (s.life <= 0) {
          synapses.splice(i, 1);
          continue;
        }

        const alpha = s.life * 0.22 * breathe;
        if (alpha < 0.003) continue;

        // Draw a soft bezier curve — two passes (thick dim + thin bright) to simulate glow
        const mx = (s.x1 + s.x2) / 2;
        const my = (s.y1 + s.y2) / 2 - 20 * s.life;

        // Outer glow pass — slightly thicker, dimmer
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.quadraticCurveTo(mx, my, s.x2, s.y2);
        ctx.strokeStyle = `hsla(${s.hue}, 70%, 72%, ${alpha * 0.25})`;
        ctx.lineWidth = 2.5 + s.life * 0.5;
        ctx.stroke();

        // Inner bright pass — thin core
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.quadraticCurveTo(mx, my, s.x2, s.y2);
        ctx.strokeStyle = `hsla(${s.hue}, 70%, 72%, ${alpha * 0.7})`;
        ctx.lineWidth = 0.8 + s.life * 0.3;
        ctx.stroke();

        // Glow dots at endpoints
        const dotAlpha = alpha * 1.2;
        ctx.beginPath();
        ctx.arc(s.x1, s.y1, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${s.hue}, 80%, 80%, ${dotAlpha})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(s.x2, s.y2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(frame);
    };

    // ── Inject a coherent phrase across adjacent columns ──
    function injectPhrase() {
      const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];

      // Find adjacent mid/near layer columns that are currently visible
      const eligible = columns.filter((c) =>
        c.layer >= 1 &&
        c.y > -100 && c.y < H &&
        !c.phraseActive
      );
      if (eligible.length < phrase.length) return;

      // Sort by x position and pick a contiguous group
      eligible.sort((a, b) => a.x - b.x);
      const startIdx = Math.floor(Math.random() * Math.max(1, eligible.length - phrase.length));

      for (let i = 0; i < phrase.length; i++) {
        const col = eligible[startIdx + i];
        if (!col) break;
        col.phraseActive = true;
        col.phraseWord = phrase[i];
        col.phraseGlow = 0;

        // Schedule deactivation
        setTimeout(() => {
          col.phraseActive = false;
          // phraseGlow will fade naturally in the render loop
        }, 2500 + Math.random() * 1500);
      }
    }

    animRef.current = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", init);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-[5] pointer-events-none"
      aria-hidden="true"
    />
  );
}
