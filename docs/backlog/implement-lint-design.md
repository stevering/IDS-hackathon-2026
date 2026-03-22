# Implement LINT_DESIGN adapter

## Context

The FC MCP `LINT_DESIGN` method is a WCAG accessibility audit (~500 lines in the native FC plugin's `code.js`). It performs contrast ratio calculations, text size checks, background color traversal, and other accessibility validations.

In our FC Bridge, `LINT_DESIGN` is declared as a **stub** that returns "not implemented". It's the only FC method (1/37) not fully implemented.

## What the native plugin does

- sRGB linearization + relative luminance calculation
- WCAG contrast ratio between foreground and background colors
- Background color traversal (walks up parent tree for effective background)
- Large text detection (18pt regular / 14pt bold per WCAG)
- Node tree traversal with depth/findings limits
- Returns findings grouped by severity (error, warning, info)

## Approach

Too complex for the Proxy system (needs iteration, math, tree traversal). Two options:

**A) EXECUTE_CODE with the ~500 lines of JS as a template** — send the entire audit code via `figmaconsole_figma_execute`. Works but it's a very large code string.

**B) Keep as stub** — Guardian has its own DS compliance tools (`analyze_drift`, `check_component_usage`). LINT_DESIGN is specific to WCAG accessibility, which may not be Guardian's primary use case.

## Files

- `packages/figma-plugin/ui.html` — current stub in `fcMethods.LINT_DESIGN`
- Native reference: `~/.figma-console-mcp/plugin/code.js` lines 2287-2813

## Priority

Low — the stub returns a clear error message. The FC MCP tool `figma_lint_design` is rarely used by agents.
