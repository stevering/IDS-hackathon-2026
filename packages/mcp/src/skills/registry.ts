/**
 * Guardian Skills Registry
 *
 * Loads builtin skills + user-defined skills (JSON files in mcp/skills/user/).
 * Exposes getSkill, listSkills, and interpolate.
 *
 * User skills format (mcp/skills/user/<skill-name>.json):
 *   {
 *     "name": "my_skill",
 *     "description": "...",
 *     "category": "user",
 *     "params": [...],
 *     "codeTemplate": "...",
 *     "version": "1.0.0"
 *   }
 */

import { readdir, readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { BUILTIN_SKILLS } from "./builtin/index.js"
import type { Skill, SkillCategory } from "./types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

// User skills live in mcp/skills/user/ (next to src/, not inside it)
const USER_SKILLS_DIR = join(__dirname, "../../skills/user")

// --------------------------------------------------------------------------
// User skill loading
// --------------------------------------------------------------------------

async function loadUserSkills(): Promise<Skill[]> {
  if (!existsSync(USER_SKILLS_DIR)) return []
  try {
    const files = await readdir(USER_SKILLS_DIR)
    const skills = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const raw = await readFile(join(USER_SKILLS_DIR, f), "utf-8")
          const parsed = JSON.parse(raw) as Partial<Skill>
          return { ...parsed, source: "user" as const } as Skill
        })
    )
    return skills
  } catch {
    return []
  }
}

// --------------------------------------------------------------------------
// In-memory registry (lazy-loaded once)
// --------------------------------------------------------------------------

let _registry: Skill[] | null = null

async function getRegistry(): Promise<Skill[]> {
  if (_registry) return _registry
  const userSkills = await loadUserSkills()
  _registry = [...BUILTIN_SKILLS, ...userSkills]
  return _registry
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export async function getSkill(name: string): Promise<Skill | undefined> {
  const registry = await getRegistry()
  return registry.find((s) => s.name === name)
}

export async function listSkills(category?: SkillCategory | string): Promise<Skill[]> {
  const registry = await getRegistry()
  if (!category) return registry
  return registry.filter((s) => s.category === category)
}

/**
 * Interpolate a skill's codeTemplate with the provided params.
 * Replaces all {{paramName}} occurrences with the corresponding value.
 * Unknown params are left as-is.
 */
export function interpolate(skill: Skill, params: Record<string, unknown>): string {
  let code = skill.codeTemplate

  // Apply provided params
  for (const [key, value] of Object.entries(params)) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value)
    code = code.replaceAll(`{{${key}}}`, serialized)
  }

  // Apply defaults for missing optional params
  for (const param of skill.params) {
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
export function validateParams(skill: Skill, params: Record<string, unknown>): string[] {
  return skill.params
    .filter((p) => p.required && !(p.name in params))
    .map((p) => p.name)
}
