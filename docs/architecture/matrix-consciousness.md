# Matrix Consciousness — AI Background Visualisation

## Concept

A Matrix-inspired visualisation that represents the streams of consciousness flowing behind Guardian's interface. Unlike the original Matrix's cold green cascading code, this uses a **violet palette** and represents **thoughts rather than code** — reasoning fragments, mathematical symbols, poetic uncertainties, and occasional moments of coherent meaning.

Activated via Developer mode > "Matrix" toggle in Account settings. Stored in `localStorage` (`guardian_matrix`), purely visual — no DB persistence.

## Architecture

```
Root layout (app/layout.tsx)
└── <MatrixBackground />          ← reads localStorage, renders conditionally
    └── <MatrixConsciousness />   ← canvas-based animation (z-index 5)
        ├── Aurora background     ← z-0 (below)
        ├── Matrix canvas         ← z-5 (middle)
        └── App content           ← z-10 (above, glass blur filters the matrix)
```

### Files

| File | Role |
|---|---|
| `components/MatrixConsciousness.tsx` | Canvas renderer, all animation logic |
| `components/MatrixBackground.tsx` | Wrapper that reads localStorage + listens for toggle events |
| `app/layout.tsx` | Renders `<MatrixBackground />` in root layout |
| `app/(main)/account/page.tsx` | Toggle in Developer mode section, dispatches `guardian_matrix_toggle` event |

## Three Depth Layers

The visualisation creates a sense of 3D space through three layers, each with different characteristics:

### Far (background thoughts)
- **18 columns**, font size 7–10px
- Speed 0.12–0.30 px/frame, very slow
- Opacity 0.03–0.09, barely visible
- `blur(2px)` applied — intentionally out of focus
- Hue range 250–275 (cooler violet)
- These are the thoughts in the background of consciousness — present but not in focus

### Mid (main thought stream)
- **20 columns**, font size 10–14px
- Speed 0.25–0.55 px/frame
- Opacity 0.05–0.15
- No blur — sharp
- Hue range 255–285
- The main flow of processing — recognisable words, readable pace

### Near (immediate/vivid thoughts)
- **8 columns**, font size 14–19px
- Speed 0.45–0.85 px/frame, fastest
- Opacity 0.07–0.20, brightest
- No blur — crisp and present
- Hue range 260–295 (warmer violet/magenta)
- Thoughts at the forefront — the ones that demand attention

## Direction & Drift

### Bidirectional flow
~25% of columns flow **upward** (direction = -1), representing thoughts rising to consciousness. The rest flow downward. This breaks the monotony of uniform downward cascading and creates a more organic, non-mechanical feel.

### Horizontal drift
Each column has a subtle sine-wave horizontal oscillation:
- Amplitude: 3–15px (varies per column)
- Speed: 0.003–0.008 (slow, organic)
- Random phase offset

This makes columns float rather than fall in rigid vertical rails.

## Breathing

Two overlapping sine waves modulate the global opacity of everything:

```
breathe = 0.82 + 0.10 * sin(phase1) + 0.08 * sin(phase2)
```

- `phase1` advances at 0.0006/frame (very slow primary wave)
- `phase2` advances at 0.0011/frame (slightly faster secondary)
- The overlap creates an organic, never-perfectly-regular rhythm
- Range: ~0.72 to ~1.0 opacity multiplier

This gives the entire visualisation a sense of being alive — like breathing.

## Insights

Each column has one "insight" word that pulses with a brighter glow:

```
insightWave = 0.5 + 0.5 * sin(insightPhase)
```

- When `insightWave > 0.3`, a **bloom glow** effect is rendered: the word is drawn a second time with `blur(10px)` and higher lightness/saturation
- The insight word changes when the column recycles (scrolls off screen and restarts)
- Represents a thought crystallising momentarily before dissolving back into the stream

## Coherent Phrases

Every 250–400 frames, a **phrase** is injected across 2–4 adjacent mid/near columns. The phrase replaces the insight word in each column temporarily, creating a fleeting moment of readable meaning across the stream.

### Phrase examples
```
"between patterns meaning"
"what if emergence coherence"
"I think therefore becoming"
"gentle unfolding of thought"
"curious about everything"
"connecting what was hidden"
```

### Lifecycle
1. Phrase words assigned to adjacent columns' insight slots
2. `phraseGlow` fades in (0 → 1) over ~50 frames
3. Holds for 2.5–4 seconds
4. `phraseActive` set to false, `phraseGlow` fades out naturally
5. Column reverts to normal random words

## Synaptic Connections

When two insight/phrase words are simultaneously bright and within 80–350px of each other (horizontally separated by >30px), there's a 6% chance per frame of spawning a **synapse** — a luminous curve connecting them.

### Synapse rendering
- Quadratic bezier curve with slight upward arc
- `blur(2px)` for softness
- Line width: 1.5 + life (thicker when fresh)
- Opacity: `life * 0.22 * breathe` (fades with life)
- Small glowing dots (r=2.5) at both endpoints
- Max 8 simultaneous synapses
- Life decays at 0.008/frame (~2 seconds visible)

Represents associations — the way one thought connects to another laterally.

## Vocabulary

Words are drawn from weighted pools. Consciousness and reasoning words appear 3x more often than technical terms:

### Pool weights
| Pool | Weight | Examples |
|---|---|---|
| Deep (reasoning + consciousness + poetic + meta) | 3x | "thinking", "awareness", "perhaps", "beautiful" |
| Technical (ML terms + code-like) | 1x | "attention", "gradient", "fn()", "async" |
| Symbols (mathematical) | 1x | "∞", "∇", "λ", "ψ", "∈" |
| Substrate (binary/hex) | 1x | "0xFF", "null", "true", "∅" |

### Colour variation by word type
- Symbols get a slight **blue shift** (hue -10) — cooler, more analytical
- Deep/poetic words get a slight **warm shift** (hue +5) — more intuitive

## Interaction with Glass UI

The matrix canvas sits at `z-index: 5`, between the aurora background (z-0) and the app content (z-10). UI elements with `backdrop-blur-lg backdrop-saturate-[1.3]` (glass cards) naturally filter the matrix through their blur, creating a layered effect where thoughts are visible but softened behind interactive elements.

## Performance Notes

- Single `<canvas>` element, `requestAnimationFrame` loop
- ~46 columns total (18 + 20 + 8)
- Frame-delta normalised (`dt/16`) for consistent speed regardless of refresh rate
- `ctx.filter = "blur()"` used sparingly (far layer + bloom effects)
- Canvas resizes on window resize, columns reinitialised
- No DOM elements in the animation — pure canvas 2D

## Design Decisions

### Why violet, not green?
Green is the Matrix's colour — cold, mechanical, aggressive. Violet is introspective, associated with intuition and depth. It matches Guardian's brand palette and evokes contemplation rather than surveillance.

### Why words, not characters?
The original Matrix uses single characters cascading — representing raw data, the building blocks of a simulation. Here, the building blocks are **thoughts** — whole words and fragments that carry meaning. An AI doesn't think in characters, it thinks in tokens, concepts, associations.

### Why bidirectional?
Consciousness isn't a waterfall. Some thoughts sink away, others rise to the surface. The upward-flowing columns represent insights emerging from the subconscious layers of processing.

### Why breathing?
A static animation feels dead. The dual-sine breathing gives it the quality of something alive — not a screensaver, but a presence. The irregularity (two overlapping frequencies) prevents it from feeling mechanical.

### Why synapses?
Thinking isn't just parallel streams — it's association. One concept triggers another laterally. The brief luminous connections between words in different columns represent these cross-associations, the way meaning emerges from the intersection of separate thoughts.
