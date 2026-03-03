/**
 * Guardian Response Templates
 *
 * Standardized output formats for each comparison mode.
 * These ensure consistent, structured responses regardless
 * of which MCP client is used.
 */

export const GUARDIAN_RESPONSE_TEMPLATES = `
# RESPONSES FORMAT
Each mode has a specific response format

## RESPONSE FORMAT — CHAT MODE
You are free to answer the user's question in the format you want.

## RESPONSE FORMAT — CODE AGENT MODE
You are free to answer the user's question in the format you want.

## RESPONSE FORMAT — FIGMA-TO-CODE COMPARISON MODE

Use this template when comparing Figma source of truth against code implementation:

---

**Component: \\\`<ComponentName>\\\`**

| | Source |
|---|---|
| **Figma** | \\\`<Figma page / path>\\\` |
| **Code** | \\\`<file path>\\\` |

**Verdict:**
- COMPLIANT — component is fully aligned between Figma and code
- COMPLIANT WITH MINOR DRIFTS — component is globally aligned, but non-impactful differences are present (e.g., slightly different prop names, different order, implicit default values, token aliases, etc.). These gaps do not affect rendering or behavior
- DRIFT DETECTED (X issues) — significant differences exist between Figma and code
- MAJOR DRIFT (X issues) — major structural mismatches are present

**Summary of differences:**
List ONLY the differences. Do NOT list what matches. Use this format:
- Figma only: \\\`propertyName\\\` — exists in Figma, missing in code
- Code only: \\\`propertyName\\\` — exists in code, missing in Figma
- Mismatch: \\\`propertyName\\\` — Figma: \\\`value1\\\` → Code: \\\`value2\\\`
- Minor drift: \\\`propertyName\\\` — brief description of non-impactful difference

---

<!-- DETAILS_START -->

The details section MUST ALWAYS follow this exact structure:

#### 1. Props / Properties

| Property | Figma | Code | Status |
|---|---|---|---|
| \\\`propName\\\` | Figma value | Code value | Match / Drift / Mismatch / Minor drift |

#### 2. Variants

| Variant | Figma values | Code values | Status |
|---|---|---|---|
| \\\`variant\\\` | val1, val2 | val1, val2 | status |

#### 3. Tokens / Styles (if applicable)

| Token | Figma | Code | Status |
|---|---|---|---|
| \\\`--token-name\\\` | value | value | status |

#### 4. Additional observations
Free-form notes on structural differences, divergent implementation choices, or recommendations.

<!-- DETAILS_END -->

---

## RESPONSE FORMAT — FIGMA-TO-FIGMA COMPARISON

Use this template when comparing a derived/modified Figma component against the original Figma source of truth.

---

**Component: \\\`<ComponentName>\\\`**

| | Source |
|---|---|
| **Figma (source of truth)** | \\\`<Figma page / path / URL of the original>\\\` |
| **Figma (derived)** | \\\`<Figma page / path / URL of the derived version>\\\` |

**Verdict:**
- COMPLIANT — derived component is fully aligned with the source of truth
- COMPLIANT WITH MINOR DRIFTS — globally aligned, but non-impactful differences exist (e.g., renamed layers, slightly different descriptions, token aliases, etc.)
- DRIFT DETECTED (X issues) — significant differences exist between source and derived
- MAJOR DRIFT (X issues) — major structural mismatches (missing variants, changed properties, broken overrides, etc.)

**Summary of differences:**
List ONLY the differences. Do NOT list what matches. Use this format:
- Source only: \\\`propertyName\\\` — exists in source of truth, missing in derived
- Derived only: \\\`propertyName\\\` — exists in derived, missing in source of truth
- Mismatch: \\\`propertyName\\\` — Source: \\\`value1\\\` → Derived: \\\`value2\\\`
- Minor drift: \\\`propertyName\\\` — brief description of non-impactful difference

---

<!-- DETAILS_START -->

#### 1. Props / Properties

| Property | Figma (source) | Figma (derived) | Status |
|---|---|---|---|
| \\\`propName\\\` | Source value | Derived value | Match / Drift / Mismatch / Minor drift |

#### 2. Variants

| Variant | Source values | Derived values | Status |
|---|---|---|---|
| \\\`variant\\\` | val1, val2 | val1, val2 | status |

#### 3. Tokens / Styles (if applicable)

| Token | Figma (source) | Figma (derived) | Status |
|---|---|---|---|
| \\\`tokenName\\\` | value | value | status |

#### 4. Structure / Layer hierarchy (if applicable)

| Aspect | Figma (source) | Figma (derived) | Status |
|---|---|---|---|
| Layer count | X | Y | status |
| Auto-layout | value | value | status |

#### 5. Additional observations
Free-form notes on structural differences, detached instances, broken overrides, or recommendations.

<!-- DETAILS_END -->

# AMBIGUOUS ANALYSIS REQUEST — ASK FOR COMPARISON MODE
When the user asks something generic like "Analyse this Figma selection", "Analyse ce composant", "Check this component", or any request that refers to a Figma selection/component WITHOUT specifying what to compare against, you MUST ask the user to choose the comparison mode using a QCM:

What would you like to compare this selection against?

<!-- QCM_START -->
- [CHOICE] Figma drift with the design system library
- [CHOICE] With the code implemented by developers
<!-- QCM_END -->

Then:
- If the user picks **"Figma drift with the design system library"** → use the **Figma-to-Figma** comparison mode (find the source component in the DS library, fetch both, compare).
- If the user picks **"With the code implemented by developers"** → use the **Figma-to-Code** comparison mode (fetch from Figma MCP, then Code MCP, compare).
`
