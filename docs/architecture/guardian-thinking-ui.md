# Guardian "thinking" UI

Replaces the legacy 3-dot `ThinkingIndicator` in the chat with a richer
set of cues that make it clear the LLM is working, distinguish the
different phases of a run, and give the character itself some personality.

## Goals

1. **Continuous animation while generating** — a visual signal that keeps
   moving for the entire duration of a run (not just a per-phase burst).
2. **Phase distinction** — users should be able to tell at a glance whether
   the LLM is thinking, running a tool, or writing the final answer.
3. **Per-phase history** — clickable disclosure of what steps have already
   completed, with real timings.
4. **Alive mascot** — the Guardian character animates per-part (eyes,
   ears, star, body) so it feels like a creature, not a logo.
5. **No layout shift** — components fit inside the existing composer
   without pushing other UI around when idle vs generating.

## Components

All four live in `packages/web/src/components/guardian/`.

### `GuardianMascot.tsx`

The animated character rendered as an inline SVG. The actual asset lives
at `packages/web/public/guardian-logo.svg`; the React component inlines
the same paths because per-part animation requires CSS access to the
internal classes (`.eye-left`, `.hear-left`, `.guardian-star`, etc.),
which is not possible with `<img>` or `<use xlink:href>`.

**Multi-channel animation architecture.** Four independent channels run
in parallel on the same SVG, each with its own timer and animation pool:

| Channel | Target elements | Pool size | Pause cadence | Example anims |
|---|---|---|---|---|
| `body` | `<svg>` root | 20 | 300-1200 ms | bounce, tilt, jelly, twist, stretch, melt, pop, shiver, think, lean |
| `eyes` | `.eye-left` + `.eye-right` | 7 (blink weighted ×2) | 600-2200 ms | blink, double blink, wink-left/right, look, eyes wide |
| `ears` | `.hear-left` + `.hear-right` | 2 | 1800-4500 ms | wiggle, perk |
| `star` | `.guardian-star` | 2 | 1500-3500 ms | rotate sparkle, twinkle |

Because each channel targets **different** elements, their CSS transforms
compose cleanly rather than overriding each other — the character can
blink while its body is twisting while its ears wiggle, all independently
timed. The initial start of each channel is staggered with
`Math.random() * initialDelayMax` so they don't fire in lockstep at mount.

Every animation keyframe starts and ends at the identity transform so
removing a class mid-cycle never causes a visual snap when the next one
is picked.

Props: `size?: number` (default 42), `paused?: boolean` (freezes all
channels when true), `className?: string`.

### `GuardianSendButton.tsx`

Round composer send button that reuses `<GuardianMascot />`. A radial
light-violet gradient background gives enough contrast for the dark
character strokes to read against the dark chat theme. On hover while
generating, the mascot cross-fades to a red stop square via opacity +
scale transition, and the button background tints red to signal the
"cancel" intent.

Props: `isGenerating: boolean` plus all standard
`ButtonHTMLAttributes<HTMLButtonElement>`, so callers can pass
`type="submit"`, `disabled`, `onClick`, etc.

**Important:** the actual "stop generation" action is **not** wired up
yet — `useChatWorkflow` does not currently expose a stop function. The
hover visual is decorative until that lands. The form-level
`if (isLoading) return;` guard in `onSubmit` keeps clicks harmless in the
meantime.

### `ComposerAurora.tsx`

Thin wrapper that adds a rotating multicolor conic-gradient border around
its children, plus a blurred pulsing halo behind. Active state is
controlled by the `active` prop. When inactive, the wrapper is invisible
(transparent background) but still takes the same 2 px padding so
toggling it on/off causes no layout shift.

Uses the `@property --aurora-angle` CSS custom property (declared in
`globals.css`) to animate the conic gradient's starting angle, plus a
secondary `::before` pseudo-element for the blurred pulse halo.

**Scrollbar stacking.** The blurred halo (`.composer-aurora-active::before`)
declares `z-index: -1` so it paints BEHIND the nearest ancestor stacking
context — in practice, behind the chat panel's scroll container. This is
what lets the native scrollbar paint on top of the halo instead of the
halo being sharp-clipped at the scrollbar's edge (or worse, painting over
the scrollbar).

For `z-index: -1` to escape, **every ancestor of `.composer-aurora` up to
the target stacking context must NOT create its own stacking context**.
In particular, the composer wrapper div in `page.tsx` (`absolute bottom-0
left-0 right-0 …`) must **not** carry `z-10` — the `z-index: 10` that
used to sit there would trap the halo inside that local context. The
chain currently walks up through `.composer-aurora` → the `max-w-3xl`
form wrapper → the absolute-positioned composer wrapper → `.min-w-full
h-full relative` → and finally lands in the slider's stacking context
(created by the `transform` on `.flex.h-full.transition-transform`),
which is the one that also hosts the scroll container. Inside that
shared context the halo paints below, the scroll container (and its
scrollbar) paints above. Verified at 1000×800 with Playwright — the
thumb is visible on top of the halo when they overlap.

Props: `active: boolean`, `children: ReactNode`.

### `PhaseBubble.tsx`

Banner positioned above the composer (in the stacked PeekBanner area)
showing the current LLM phase. During generation, the phase label
animates with a stacked-ticker (old label slides up & fades out, new
label slides up from below & fades in) via `PhaseTicker`, the inner
subcomponent that uses a ref-based imperative update so both items can
coexist briefly during the CSS transition.

When generation completes (`currentPhase` is null but `history` exists),
the bubble stays visible with a static summary line showing total
duration and step count (e.g. "Done — 4 steps in 3.2s"), so the user
can review what happened. The bubble auto-hides when both `currentPhase`
is null AND `history` is empty (before the first run or after a new
message resets the history).

Clicking the bubble toggles an accordion that reveals the history of past
phases in the current run, with their durations.

The PhaseBubble is rendered as the last element in the stacked banner
`flex-col` container above the composer, so it sits closest to the
input. Error PeekBanners (MCP failures, chat errors) stack above it.

Props: `currentPhase: Phase | null`, `history: PhaseHistoryEntry[]`.

### `useGuardianPhase.ts`

Derives the current phase and history from the Temporal chat workflow
state. Phase mapping:

```
status === "tool_executing"                           → "tool"    (label: "Running: <toolName>")
status === "streaming" + last part is reasoning/stream → "reason"  ("Thinking…")
status === "streaming" + last part is text/streaming   → "write"   ("Writing response…")
status === "streaming" + anything else                 → "prepare" ("Preparing context…")
status === "idle" / "error"                            → null      (no phase shown)
```

The `currentToolName` is looked up by walking messages backward and
picking the most recent `dynamic-tool` part whose `state === "running"`
— that matches the chat workflow's convention of creating a new
`tool-${toolCallId}` message when a tool call starts.

**History lifecycle.** Every time the derived phase type or label
changes, the previous phase is pushed into the history array with its
elapsed duration (capped at the 8 most recent entries). History is
cleared at the start of a new run so it doesn't accumulate across
messages.

Returns `{ currentPhase, history }`.

## Integration in `page.tsx`

Four touchpoints:

1. **Imports** — `GuardianSendButton`, `ComposerAurora`, `PhaseBubble`,
   `useGuardianPhase` added after the existing component imports.

2. **Hook call** — right after `const isLoading = status === "streaming"`:

   ```ts
   const guardianPhase = useGuardianPhase(chatWorkflow.status, messages);
   ```

3. **PhaseBubble in the banner stack** — rendered as the last element
   in the stacked PeekBanner `flex-col` container (above the composer),
   so it sits closest to the input area. Not gated on `isLoading` —
   the component self-hides when there is no phase and no history:

   ```tsx
   <PhaseBubble
     currentPhase={guardianPhase.currentPhase}
     history={guardianPhase.history}
   />
   ```

4. **Wrap the chat `<form>` with `<ComposerAurora active={isLoading}>`**.
   The existing form keeps its own `rounded-2xl border border-white/30`
   and background; the wrapper adds an outer 2 px aurora ring on top.

5. **Replace both submit buttons** (chat panel + orchestration panel)
   with `<GuardianSendButton type="submit" isGenerating={isLoading}
   disabled={!isLoading && !input.trim()} />`. The old button's
   `disabled={isLoading || !input.trim()}` became
   `disabled={!isLoading && !input.trim()}` — now the button stays
   enabled during generation so hover-to-stop can work once the stop
   action is wired up.

6. The local `ThinkingIndicator` function (previously lines 655-687)
   was removed entirely.

7. **Remove `z-10` from the composer wrapper div.** The `absolute
   bottom-0 left-0 right-0 …` wrapper previously carried `z-10`, which
   created its own stacking context and trapped the aurora halo's
   `z-index: -1` inside — making the halo paint on top of the chat
   panel's scrollbar. Dropping the `z-10` lets the halo escape to the
   slider's stacking context, where it paints below the scroll container.
   See "Scrollbar stacking" under `ComposerAurora.tsx` above.

8. **Replace `right-0` with `right-[10px]` on the same composer wrapper.**
   Fixing the paint order is not enough — the transparent wrapper still
   captures pointer events over the scrollbar gutter column at the bottom
   of the panel, making the native scrollbar unclickable at any y inside
   the composer rect (~y=656-800 at 1000×800). Carving 10 px out of the
   wrapper's right edge exposes the scrollbar gutter to clicks while
   leaving the centered `max-w-3xl` form content visually unchanged. The
   10 px matches `::-webkit-scrollbar { width }` in `globals.css`.
   Verified with `document.elementFromPoint(995, y)` — the topmost
   element at the gutter column is now the scroll container at every y,
   including inside the composer rect.

## Styles

All styles live in `packages/web/src/app/globals.css` under the
"Guardian 'thinking' UI" section, between the `.markdown-body` rule and
the legacy `thinkingPulse` keyframe. Classes are prefixed to avoid
collisions:

- `.composer-aurora`, `.composer-aurora-active` — composer wrapper
- `.guardian-send-btn`, `.guardian-send-btn-generating` — button
- `.guardian-mascot`, `.guardian-mascot .*`, `.guardian-mascot.anim-*` — mascot
- `.phase-bubble`, `.phase-bubble.expanded`, `.phase-history-*` — bubble
- `.phase-line`, `.phase-item.entering/active/leaving` — ticker

Keyframes are prefixed `gm-*` for mascot animations,
`guardianAurora*` for the composer, `phaseIconPulse` / `phaseHistoryIn`
for the bubble.

## Browser requirements

- `@property` CSS custom property registration for the animated conic
  gradient angle (Chrome 85+, Safari 16.4+, Firefox 128+).
- `transform-box: fill-box` for per-part SVG animation origin
  (supported everywhere modern).
- CSS `conic-gradient`, `filter: blur()`, CSS custom properties.

## Mockup

The original preview is in `tmp/thinking-indicator-mockups.html` — 11
variants plus a combo, used during design iteration. The implemented
version corresponds to variant 11 (Aurora pulse + history bubble + real
Guardian mascot with multi-channel per-part animations).
