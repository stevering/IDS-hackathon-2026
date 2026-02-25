/**
 * Guardian Investigation Playbooks
 *
 * Pre-defined investigation strategies for each category of DS question.
 * The Guardian has no static knowledge of your design system — these playbooks
 * tell the calling agent *what to look for*, *where to look*, and *how to interpret*
 * findings using the available MCP tools (Figma, GitHub, code editor, etc.).
 */

export type QuestionCategory =
  | "component_usage"
  | "drift_detection"
  | "snowflake_check"
  | "pattern_recognition"
  | "governance_request"
  | "general"

export type AvailableTool =
  | "figma_mcp"       // Figma design files, component libraries, tokens
  | "github_mcp"      // Source code, PRs, history
  | "code_editor_mcp" // Local codebase, Storybook, docs
  | "figma_console_mcp" // Figma plugin console (runtime inspection)
  | "any"             // No specific tool preference

export type ActionType =
  | "search"    // Find by name/keyword
  | "compare"   // Compare two things (component vs master, design vs code)
  | "inspect"   // Deep-dive into a specific element
  | "list"      // Enumerate available items
  | "diff"      // Show differences between versions

export type InvestigationStep = {
  id: string
  goal: string
  tool: AvailableTool
  action_type: ActionType
  suggested_query: string  // May contain {componentName}, {figmaNodeId}, {currentFile} tokens
  what_to_look_for: string[]
  skip_if?: string  // Condition under which this step can be skipped
}

export type Playbook = {
  category: QuestionCategory
  summary_template: string
  priority: "high" | "medium" | "low"
  steps: InvestigationStep[]
  drift_signals: string[]
  interpretation_guide: {
    what_indicates_compliance: string[]
    what_indicates_drift: string[]
    escalation_threshold: string
  }
}

export const PLAYBOOKS: Record<QuestionCategory, Playbook> = {
  component_usage: {
    category: "component_usage",
    summary_template:
      "Investigate if an existing DS component covers this use case before building a custom solution.",
    priority: "high",
    steps: [
      {
        id: "cu-1",
        goal: "Find the component in the Figma design system library",
        tool: "figma_mcp",
        action_type: "search",
        suggested_query:
          "Search for '{componentName}' in the design system Figma library file",
        what_to_look_for: [
          "Exact name match for '{componentName}'",
          "Similar component names (e.g., Button → IconButton, LinkButton)",
          "Available variant properties and their values",
          "Component description or annotation in Figma",
        ],
      },
      {
        id: "cu-2",
        goal: "Find the code implementation in the design system repo",
        tool: "github_mcp",
        action_type: "search",
        suggested_query:
          "Search for '{componentName}' component file in /design-system-sample/src",
        what_to_look_for: [
          "Component file exists (e.g., Button.tsx, Button/index.tsx)",
          "Storybook story file exists (e.g., Button.stories.tsx)",
          "Exported props/API surface",
          "Available variants as prop values",
        ],
      },
      {
        id: "cu-3",
        goal: "Find alternative components that might already solve this need",
        tool: "code_editor_mcp",
        action_type: "list",
        suggested_query:
          "List all exported components from /design-system-sample/src to identify alternatives to '{componentName}'",
        what_to_look_for: [
          "Components with overlapping functionality",
          "Compound or composed components",
          "Components with a variant that could satisfy the use case",
        ],
        skip_if: "Component was found in both cu-1 and cu-2 with the required variant",
      },
    ],
    drift_signals: [
      "No matching component found in DS → high snowflake risk, consider governance request",
      "Component found in Figma but missing from codebase → design/code parity gap",
      "Similar component exists with different naming → naming inconsistency",
      "Component found but required variant is missing → detach/override risk",
    ],
    interpretation_guide: {
      what_indicates_compliance: [
        "Component found in both Figma library and codebase with consistent names",
        "Required variant exists as a documented prop value",
        "Storybook story demonstrates the exact use case",
      ],
      what_indicates_drift: [
        "Component not found in DS → likely custom implementation",
        "Found in Figma but not in code → design-code parity gap",
        "Component found but used token values differ from Figma master → token drift",
        "Required variant missing → detach risk",
      ],
      escalation_threshold:
        "Escalate to DS team if: component is missing AND 2+ teams need it, OR the same missing variant has been workaround-ed 3+ times.",
    },
  },

  drift_detection: {
    category: "drift_detection",
    summary_template:
      "Detect and measure design/code drift for '{componentName}' or the pattern in context.",
    priority: "high",
    steps: [
      {
        id: "dd-1",
        goal: "Get canonical properties from the Figma DS library component",
        tool: "figma_mcp",
        action_type: "inspect",
        suggested_query:
          "Get all properties, token bindings, and variants for the master '{componentName}' component in the DS library",
        what_to_look_for: [
          "Token variable bindings (color, spacing, typography, radius)",
          "Canonical variant names and allowed property values",
          "Auto-layout specifications",
          "Layer structure and composition",
        ],
      },
      {
        id: "dd-2",
        goal: "Compare the current Figma usage against the master component",
        tool: "figma_mcp",
        action_type: "compare",
        suggested_query:
          "Inspect Figma node '{figmaNodeId}' and compare its property overrides against the master component definition",
        what_to_look_for: [
          "Local token overrides (hardcoded color/spacing values instead of variables)",
          "Detached status (component detached from master)",
          "Hidden layers used to create pseudo-variants",
          "Custom layers added outside the master structure",
          "Variant property values not in the master's allowed set",
        ],
        skip_if: "No figmaNodeId provided in context",
      },
      {
        id: "dd-3",
        goal: "Check code implementation for drift against DS component API",
        tool: "github_mcp",
        action_type: "diff",
        suggested_query:
          "Find usages of '{componentName}' in product code and check for prop overrides, inline styles, or reimplementations",
        what_to_look_for: [
          "Inline style props with hardcoded values instead of DS tokens/classes",
          "className overrides that contradict DS token variables",
          "Local copy of the component file instead of import from DS package",
          "CSS variables or tokens used with non-DS values",
          "Props passed that don't exist in the DS component API",
        ],
      },
      {
        id: "dd-4",
        goal: "Check for token drift specifically",
        tool: "code_editor_mcp",
        action_type: "search",
        suggested_query:
          "Search '{currentFile}' for hardcoded color, spacing, or font values instead of DS token variables",
        what_to_look_for: [
          "Hex/rgb color values not referencing var(--ds-*) tokens",
          "px/rem spacing values not using DS spacing scale",
          "Font sizes/weights not using DS typography tokens",
        ],
        skip_if: "No currentFile context provided",
      },
    ],
    drift_signals: [
      "Token value overridden locally (e.g., color: #FF0000 instead of var(--ds-color-primary))",
      "Component detached from Figma master component",
      "Custom CSS class or style prop bypassing DS token system",
      "Component file duplicated in product codebase instead of imported from DS",
      "Variant property used that is not in the DS master component definition",
    ],
    interpretation_guide: {
      what_indicates_compliance: [
        "All color/spacing/typography values reference DS token variables",
        "Figma node is linked to master component with no token overrides",
        "Code imports component from DS package, uses only documented props",
        "No inline styles on DS-managed components",
      ],
      what_indicates_drift: [
        "Hardcoded values instead of tokens anywhere in the component chain",
        "Figma override on a token-bound property",
        "Forked/copied component file in product repository",
        "Props or variant values not present in DS documentation",
      ],
      escalation_threshold:
        "Escalate if: same drift pattern appears in 3+ files/components, OR drift involves a token that cascades to 10+ components.",
    },
  },

  snowflake_check: {
    category: "snowflake_check",
    summary_template:
      "Assess whether '{componentName}' is a legitimate product-specific edge case or a snowflake that should be standardized.",
    priority: "medium",
    steps: [
      {
        id: "sc-1",
        goal: "Check if this pattern exists elsewhere in the product codebase",
        tool: "github_mcp",
        action_type: "search",
        suggested_query:
          "Search all product repositories for similar component structures, naming patterns, or business logic related to '{componentName}'",
        what_to_look_for: [
          "Same or similar component name used across multiple features/repos",
          "Structurally similar JSX/component composition",
          "Shared business requirement driving the custom implementation",
        ],
      },
      {
        id: "sc-2",
        goal: "Search for similar UI patterns in Figma product files",
        tool: "figma_mcp",
        action_type: "search",
        suggested_query:
          "Search across all product Figma files for UI patterns visually similar to the current design",
        what_to_look_for: [
          "Same layout or compositional structure across multiple files",
          "Repeated use of the same custom color/spacing combinations",
          "Same UI pattern solved differently by different designers",
        ],
      },
      {
        id: "sc-3",
        goal: "Find the closest DS component to determine if a variant would solve this",
        tool: "figma_mcp",
        action_type: "search",
        suggested_query:
          "List DS components and find the closest match to '{componentName}' to assess how close the DS already is",
        what_to_look_for: [
          "DS component with 80%+ structural overlap",
          "DS component that is missing only one specific variant or property",
          "Compound component approach that could compose an equivalent solution",
        ],
      },
    ],
    drift_signals: [
      "Pattern found in 3+ places → likely emerging standard, not a true snowflake",
      "Close DS match exists but missing one variant → governance case, not a snowflake",
      "Completely unique pattern with no DS equivalent AND single product context → true snowflake",
    ],
    interpretation_guide: {
      what_indicates_compliance: [
        "Pattern is genuinely unique to this product domain or business logic",
        "No close DS equivalent exists after thorough search",
        "Business constraint or regulatory requirement justifies the custom solution",
      ],
      what_indicates_drift: [
        "Pattern found in multiple places → not a unique edge case, duplication",
        "DS component exists with 90%+ overlap → near-snowflake, should use DS",
        "Pattern independently built by 3+ teams → missing DS component",
      ],
      escalation_threshold:
        "Escalate to DS team if: pattern found in 3+ separate places, OR a DS component is only one missing variant away from full compliance.",
    },
  },

  pattern_recognition: {
    category: "pattern_recognition",
    summary_template:
      "Identify if this is an emerging cross-team pattern worth formalizing in the design system.",
    priority: "medium",
    steps: [
      {
        id: "pr-1",
        goal: "Map all existing instances of this pattern across teams and repositories",
        tool: "github_mcp",
        action_type: "search",
        suggested_query:
          "Search all repositories for components or patterns similar to '{componentName}', counting distinct implementations",
        what_to_look_for: [
          "Number of distinct implementations (1 = isolated, 3+ = emerging pattern)",
          "Implementation consistency across teams",
          "Teams that have independently built this",
        ],
      },
      {
        id: "pr-2",
        goal: "Assess pattern consistency in Figma across teams",
        tool: "figma_mcp",
        action_type: "compare",
        suggested_query:
          "Compare all instances of this pattern across different team Figma files to measure visual consistency",
        what_to_look_for: [
          "Consistent token usage across all instances",
          "Consistent structure and layout approach",
          "Consistent naming conventions",
          "Variations that suggest different mental models",
        ],
      },
    ],
    drift_signals: [
      "Pattern found 5+ times with consistent implementation → ready for DS inclusion proposal",
      "Pattern found but implemented inconsistently → standardization needed before DS inclusion",
      "Pattern found only in one team → too early to standardize",
    ],
    interpretation_guide: {
      what_indicates_compliance: [
        "Pattern is documented with a clear rationale",
        "Single source of truth exists (or teams have aligned)",
        "Usage is consistent across all teams implementing it",
      ],
      what_indicates_drift: [
        "Multiple implementations with subtle but meaningful differences",
        "No documentation or shared rationale",
        "Pattern duplicated across teams without awareness of each other",
      ],
      escalation_threshold:
        "Propose DS addition if: pattern appears in 5+ distinct places with consistent implementation, OR 3+ teams have independently built the same solution.",
    },
  },

  governance_request: {
    category: "governance_request",
    summary_template:
      "Evaluate whether this use case justifies a formal design system extension request.",
    priority: "low",
    steps: [
      {
        id: "gr-1",
        goal: "Document the exact gap — what is missing from the DS that drives this request",
        tool: "figma_mcp",
        action_type: "inspect",
        suggested_query:
          "Inspect the current DS '{componentName}' component and enumerate what variant, property, or token is missing for this use case",
        what_to_look_for: [
          "Specific missing variant name and what it would look like",
          "The user/product context driving the need",
          "Whether the gap is a missing variant, missing component, or missing token",
        ],
      },
      {
        id: "gr-2",
        goal: "Find evidence that this gap affects other teams",
        tool: "github_mcp",
        action_type: "search",
        suggested_query:
          "Search for workarounds, custom overrides, or TODO comments that suggest teams are hitting the same DS gap",
        what_to_look_for: [
          "Repeated workarounds with the same intent across multiple PRs or files",
          "Comments referencing DS limitations or missing components",
          "Custom tokens that override DS defaults in the same direction",
        ],
      },
    ],
    drift_signals: [
      "Multiple teams have independently created the same workaround → strong governance signal",
      "Custom solution is a simple variant addition away from full DS compliance → quick win for DS team",
    ],
    interpretation_guide: {
      what_indicates_compliance: [
        "Use case is genuinely unique to one product with no shared need",
        "Workaround is minimal, well-documented, and isolated",
      ],
      what_indicates_drift: [
        "Multiple teams hitting the same gap → DS has a real hole",
        "Workaround is growing in complexity and spreading",
      ],
      escalation_threshold:
        "File a formal DS request if: the gap affects 2+ teams, OR the fix is a simple variant addition (low DS team effort, high adoption impact).",
    },
  },

  general: {
    category: "general",
    summary_template:
      "General DS investigation — use a broad approach to understand available resources and identify gaps.",
    priority: "medium",
    steps: [
      {
        id: "gen-1",
        goal: "Discover available DS resources in Figma",
        tool: "figma_mcp",
        action_type: "list",
        suggested_query:
          "List all available components and token collections in the design system Figma library",
        what_to_look_for: [
          "Component catalog with categories",
          "Token collections (color, spacing, typography, radius, elevation)",
          "Design guidelines or annotation frames",
        ],
      },
      {
        id: "gen-2",
        goal: "Discover available DS resources in code",
        tool: "code_editor_mcp",
        action_type: "list",
        suggested_query:
          "List exported components and token files from /design-system-sample to understand what is available in code",
        what_to_look_for: [
          "Component index exports",
          "Storybook stories as living documentation",
          "CSS token files or JS token exports",
          "README or migration guides",
        ],
      },
    ],
    drift_signals: [
      "No DS resource found for the question topic → potential documentation or component gap",
      "Documentation found but contradicts actual implementation → parity issue",
    ],
    interpretation_guide: {
      what_indicates_compliance: [
        "Existing DS resource fully addresses the question",
        "Documentation matches the code implementation",
      ],
      what_indicates_drift: [
        "No DS resource found for a commonly needed pattern",
        "Documentation is outdated or incomplete relative to code",
      ],
      escalation_threshold:
        "Escalate if no DS resource exists for a pattern that is clearly a shared, recurring need.",
    },
  },
}
