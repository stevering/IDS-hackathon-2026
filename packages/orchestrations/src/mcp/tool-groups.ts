/**
 * Smart Tool Selection — tool group registry, scoring, and filtering.
 *
 * When the chat has too many MCP tools (>40), tools are pre-filtered based
 * on the user's message. Each tool belongs to a functional group; groups are
 * scored against the message via keyword matching. The LLM can load more
 * groups on demand via `guardian_load_tool_group`.
 *
 * All functions in this module are **pure** (no I/O, no Date, no randomness)
 * — safe to call directly inside a Temporal workflow.
 */

import type { LLMToolDefinition } from "../types/agents.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolGroup = {
  /** Unique ID used by `guardian_load_tool_group` (e.g., "figma_variables"). */
  id: string;
  /** Human-readable label for the system prompt. */
  label: string;
  /** Which instance category this group applies to. */
  category: "design" | "code";
  /**
   * Patterns matched against **raw** tool names (without instance prefix).
   * A tool matches if its raw name equals or starts with any pattern.
   */
  toolPatterns: string[];
  /**
   * Keywords matched against the user message (lowercase).
   * Both French and English keywords are supported.
   */
  keywords: string[];
  /** Short description shown in the system prompt. */
  description: string;
  /** If true, this group is always injected regardless of score. */
  alwaysInclude?: boolean;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOL_GROUPS: ToolGroup[] = [
  // ── Design: Figma Console ─────────────────────────────────────────────────

  {
    id: "figma_core",
    label: "Figma Core",
    category: "design",
    toolPatterns: [
      "figma_get_file_data",
      "figma_capture_screenshot",
      "figma_execute",
      "figma_pair_plugin",
      "figma_get_file_for_plugin",
      "figma_get_styles",
      "figma_get_text_styles",
    ],
    keywords: [],
    description: "Essential Figma: file data, screenshots, styles, plugin execution",
    alwaysInclude: true,
  },
  {
    id: "figma_editing",
    label: "Figma Node Editing",
    category: "design",
    toolPatterns: [
      "figma_create_child",
      "figma_set_fills",
      "figma_set_image_fill",
      "figma_set_strokes",
      "figma_set_text",
      "figma_resize_node",
      "figma_move_node",
      "figma_clone_node",
      "figma_delete_node",
      "figma_rename_node",
      "figma_set_description",
    ],
    keywords: [
      "create", "add", "make", "build", "edit", "modify", "change",
      "move", "resize", "delete", "remove", "rename", "clone", "duplicate",
      "fill", "color", "stroke", "text", "frame", "rectangle", "ellipse",
      "node", "element", "layer", "shape", "image",
      // French
      "créer", "ajouter", "fabriquer", "modifier", "changer",
      "déplacer", "redimensionner", "supprimer", "renommer", "dupliquer",
      "couleur", "texte", "forme", "calque",
    ],
    description: "Create, modify, move, resize, delete Figma nodes",
  },
  {
    id: "figma_variables",
    label: "Figma Variables & Tokens",
    category: "design",
    toolPatterns: [
      "figma_get_variables",
      "figma_create_variable",
      "figma_update_variable",
      "figma_delete_variable",
      "figma_rename_variable",
      "figma_create_variable_collection",
      "figma_delete_variable_collection",
      "figma_add_mode",
      "figma_rename_mode",
      "figma_batch_create_variables",
      "figma_batch_update_variables",
      "figma_setup_design_tokens",
    ],
    keywords: [
      "variable", "token", "design token", "color token", "spacing",
      "theme", "mode", "collection", "semantic", "primitive",
      // French
      "variable", "jeton", "thème", "mode",
    ],
    description: "Design tokens and variables: create, update, collections, modes",
  },
  {
    id: "figma_components",
    label: "Figma Components",
    category: "design",
    toolPatterns: [
      "figma_get_component",
      "figma_get_component_image",
      "figma_get_component_for_development",
      "figma_get_component_for_development_deep",
      "figma_instantiate_component",
      "figma_set_instance_properties",
      "figma_add_component_property",
      "figma_edit_component_property",
      "figma_delete_component_property",
      "figma_analyze_component_set",
      "figma_arrange_component_set",
      "figma_generate_component_doc",
      "figma_get_design_system_kit",
    ],
    keywords: [
      "component", "instance", "variant", "property", "prop",
      "library", "design system", "master", "swap", "detach",
      // French
      "composant", "variante", "propriété", "bibliothèque", "système de design",
    ],
    description: "Components: inspect, instantiate, properties, design system",
  },
  {
    id: "figma_slides",
    label: "Figma Slides",
    category: "design",
    toolPatterns: [
      "figma_list_slides",
      "figma_get_slide_content",
      "figma_get_slide_grid",
      "figma_get_slide_transition",
      "figma_get_focused_slide",
      "figma_create_slide",
      "figma_delete_slide",
      "figma_duplicate_slide",
      "figma_reorder_slides",
      "figma_set_slide_transition",
      "figma_skip_slide",
      "figma_add_text_to_slide",
      "figma_add_shape_to_slide",
      "figma_set_slide_background",
      "figma_set_slides_view_mode",
      "figma_focus_slide",
    ],
    keywords: [
      "slide", "presentation", "deck", "transition",
      // French
      "diapo", "diapositive", "présentation",
    ],
    description: "Figma Slides: create, edit, transitions, presentation",
  },
  {
    id: "figjam",
    label: "FigJam",
    category: "design",
    toolPatterns: [
      "figjam_create_sticky",
      "figjam_create_stickies",
      "figjam_create_connector",
      "figjam_create_shape_with_text",
      "figjam_create_section",
      "figjam_create_table",
      "figjam_create_code_block",
      "figjam_auto_arrange",
      "figjam_get_board_contents",
      "figjam_get_connections",
    ],
    keywords: [
      "figjam", "sticky", "stickies", "post-it", "whiteboard", "board",
      "connector", "brainstorm", "table", "section",
      // French
      "tableau blanc", "post-it", "brainstorm",
    ],
    description: "FigJam: stickies, connectors, shapes, tables, whiteboard",
  },
  {
    id: "figma_review",
    label: "Figma Review & Audit",
    category: "design",
    toolPatterns: [
      "figma_get_annotations",
      "figma_set_annotations",
      "figma_get_annotation_categories",
      "figma_lint_design",
      "figma_audit_component_accessibility",
      "figma_check_design_parity",
      "figma_get_comments",
      "figma_post_comment",
      "figma_delete_comment",
    ],
    keywords: [
      "audit", "lint", "check", "parity", "annotation", "comment",
      "review", "inspect", "accessibility", "a11y", "drift",
      // French
      "vérifier", "auditer", "annotation", "commentaire", "accessibilité",
    ],
    description: "Annotations, comments, linting, accessibility audit, parity checks",
  },

  // ── Code: IntelliJ / Code Editor ──────────────────────────────────────────

  {
    id: "code_core",
    label: "Code Core",
    category: "code",
    toolPatterns: [
      "get_file_text_by_path",
      "find_files_by_name_keyword",
      "find_files_by_glob",
      "search_in_files_by_text",
      "search_in_files_by_regex",
      "list_directory_tree",
      "get_all_open_file_paths",
      "get_symbol_info",
    ],
    keywords: [],
    description: "File reading, search, navigation, symbol info",
    alwaysInclude: true,
  },
  {
    id: "code_editing",
    label: "Code Editing",
    category: "code",
    toolPatterns: [
      "create_new_file",
      "replace_text_in_file",
      "reformat_file",
      "open_file_in_editor",
      "rename_refactoring",
    ],
    keywords: [
      "edit", "code", "fix", "refactor", "implement", "write", "create file",
      "modify", "update", "rename", "format",
      // French
      "éditer", "corriger", "modifier", "implémenter", "refactoriser", "renommer",
    ],
    description: "File editing, creation, refactoring",
  },
  {
    id: "code_build",
    label: "Code Build & Run",
    category: "code",
    toolPatterns: [
      "execute_run_configuration",
      "get_run_configurations",
      "build_project",
      "execute_terminal_command",
      "get_file_problems",
      "get_project_dependencies",
      "get_project_modules",
      "get_repositories",
      "runNotebookCell",
      "permission_prompt",
    ],
    keywords: [
      "build", "compile", "run", "test", "terminal", "command",
      "execute", "debug", "dependency", "module", "notebook",
      // French
      "compiler", "lancer", "exécuter", "tester", "dépendance",
    ],
    description: "Build, run, terminal, diagnostics, dependencies",
  },
];

// ---------------------------------------------------------------------------
// Tool selection (Option 1 — semantic pre-filtering)
// ---------------------------------------------------------------------------

/** Maximum tools to inject in a single LLM call. */
const DEFAULT_MAX_TOOLS = 35;

export type ToolSelectionResult = {
  /** IDs of selected groups. */
  selectedGroupIds: string[];
  /** Human-readable reason for logging. */
  reason: string;
};

/**
 * Score each tool group against the user's message and return the groups
 * that should be injected. Groups with `alwaysInclude` are always selected.
 * Additional groups are picked by keyword match score, up to `maxTools`.
 */
export function selectToolGroups(
  userMessage: string,
  availableRawNames: string[],
  opts?: { maxTools?: number },
): ToolSelectionResult {
  const maxTools = opts?.maxTools ?? DEFAULT_MAX_TOOLS;
  const msg = userMessage.toLowerCase();

  // Score each group by keyword hits in the user message.
  const scored: Array<{ group: ToolGroup; score: number; toolCount: number }> = [];

  for (const group of TOOL_GROUPS) {
    // Count how many of this group's tools are actually available.
    const toolCount = countGroupTools(group, availableRawNames);
    if (toolCount === 0 && !group.alwaysInclude) continue; // no tools → skip

    let score = group.alwaysInclude ? 1000 : 0; // always-include gets top priority
    for (const kw of group.keywords) {
      if (msg.includes(kw.toLowerCase())) {
        score += 3;
      }
    }
    scored.push({ group, score, toolCount });
  }

  // Sort by score descending (alwaysInclude groups first due to +1000).
  scored.sort((a, b) => b.score - a.score);

  // Pick groups until we hit the tool budget.
  const selected: string[] = [];
  let totalTools = 0;

  for (const { group, score, toolCount } of scored) {
    if (group.alwaysInclude || score > 0) {
      if (totalTools + toolCount > maxTools && !group.alwaysInclude && selected.length > 0) {
        break; // would exceed budget
      }
      selected.push(group.id);
      totalTools += toolCount;
    }
  }

  // If nothing was selected beyond core (no keyword matches), include core only.
  const reason = selected.length === 0
    ? "no groups matched, using core only"
    : `${selected.length} groups selected (${totalTools} tools): ${selected.join(", ")}`;

  return { selectedGroupIds: selected, reason };
}

// ---------------------------------------------------------------------------
// Tool filtering
// ---------------------------------------------------------------------------

/**
 * Filter tools to keep only those belonging to the selected groups.
 * Tools that don't match ANY group are included in a catch-all to avoid
 * silently dropping unknown tools.
 */
export function filterToolsByGroups(
  allTools: LLMToolDefinition[],
  selectedGroupIds: string[],
  instancePrefix: string,
): LLMToolDefinition[] {
  const selectedGroups = TOOL_GROUPS.filter((g) => selectedGroupIds.includes(g.id));

  return allTools.filter((tool) => {
    const rawName = tool.name.startsWith(instancePrefix)
      ? tool.name.slice(instancePrefix.length)
      : tool.name;

    // Check if the tool matches any selected group.
    for (const group of selectedGroups) {
      if (matchesGroup(rawName, group)) return true;
    }

    // Catch-all: if the tool doesn't match ANY known group at all, include it
    // (don't silently drop unknown tools — they may be new/custom).
    const matchesAnyGroup = TOOL_GROUPS.some((g) => matchesGroup(rawName, g));
    return !matchesAnyGroup;
  });
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a system prompt section explaining available tool groups.
 * Only injected when smart selection is active (tools were filtered).
 */
export function buildToolGroupPrompt(
  activeGroupIds: string[],
  allFocusToolCount: number,
  currentToolCount: number,
): string {
  const lines = [
    "## Smart Tool Selection",
    "",
    `Your tool catalog was optimized for this query (${currentToolCount}/${allFocusToolCount} tools loaded).`,
    "If you need tools not currently available, use `guardian_load_tool_group` to load a group.",
    "Use `guardian_list_tool_groups` to see all available groups.",
    "",
    "**Loaded groups:**",
  ];
  for (const id of activeGroupIds) {
    const g = TOOL_GROUPS.find((gr) => gr.id === id);
    if (g) lines.push(`- \`${g.id}\`: ${g.description}`);
  }

  const unloaded = TOOL_GROUPS.filter((g) => !activeGroupIds.includes(g.id));
  if (unloaded.length > 0) {
    lines.push("");
    lines.push("**Available on demand** (call `guardian_load_tool_group`):");
    for (const g of unloaded) {
      lines.push(`- \`${g.id}\`: ${g.description}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesGroup(rawName: string, group: ToolGroup): boolean {
  return group.toolPatterns.some((p) => rawName === p || rawName.startsWith(p + "_"));
}

function countGroupTools(group: ToolGroup, availableRawNames: string[]): number {
  return availableRawNames.filter((n) => matchesGroup(n, group)).length;
}
