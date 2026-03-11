/**
 * Guardian Actions Registry
 *
 * Loads builtin actions + user-defined actions (JSON files in mcp/actions/user/).
 * Exposes getAction, listActions, and interpolate.
 *
 * User actions format (mcp/actions/user/<action-name>.json):
 *   {
 *     "name": "my_action",
 *     "description": "...",
 *     "category": "user",
 *     "params": [...],
 *     "template": "...",
 *     "version": "1.0.0"
 *   }
 */

import { readdir, readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { BUILTIN_ACTIONS } from "./builtin/index.js"
import type { Action, ActionCategory } from "./types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

// User actions live in mcp/actions/user/ (next to src/, not inside it)
const USER_ACTIONS_DIR = join(__dirname, "../../actions/user")

// --------------------------------------------------------------------------
// User action loading
// --------------------------------------------------------------------------

async function loadUserActions(): Promise<Action[]> {
  if (!existsSync(USER_ACTIONS_DIR)) return []
  try {
    const files = await readdir(USER_ACTIONS_DIR)
    const actions = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const raw = await readFile(join(USER_ACTIONS_DIR, f), "utf-8")
          const parsed = JSON.parse(raw) as Partial<Action>
          return { ...parsed, source: "user" as const } as Action
        })
    )
    return actions
  } catch {
    return []
  }
}

// --------------------------------------------------------------------------
// In-memory registry (lazy-loaded once)
// --------------------------------------------------------------------------

let _registry: Action[] | null = null

async function getRegistry(): Promise<Action[]> {
  if (_registry) return _registry
  const userActions = await loadUserActions()
  _registry = [...BUILTIN_ACTIONS, ...userActions]
  return _registry
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export async function getAction(name: string): Promise<Action | undefined> {
  const registry = await getRegistry()
  return registry.find((a) => a.name === name)
}

export async function listActions(category?: ActionCategory | string): Promise<Action[]> {
  const registry = await getRegistry()
  if (!category) return registry
  return registry.filter((a) => a.category === category)
}

/**
 * Interpolate an action's template with the provided params.
 * Replaces all {{paramName}} occurrences with the corresponding value.
 * Unknown params are left as-is.
 */
export function interpolate(action: Action, params: Record<string, unknown>): string {
  let code = action.template

  // Apply provided params
  for (const [key, value] of Object.entries(params)) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value)
    code = code.replaceAll(`{{${key}}}`, serialized)
  }

  // Apply defaults for missing optional params
  for (const param of action.params) {
    if (!param.required && param.default !== undefined) {
      const serialized =
        typeof param.default === "string" ? param.default : JSON.stringify(param.default)
      code = code.replaceAll(`{{${param.name}}}`, serialized)
    }
  }

  return code
}

/**
 * Validate that all required params are present.
 * Returns an array of missing param names (empty = valid).
 */
export function validateParams(action: Action, params: Record<string, unknown>): string[] {
  return action.params
    .filter((p) => p.required && !(p.name in params))
    .map((p) => p.name)
}
