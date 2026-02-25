/**
 * Built-in Guardian skills
 *
 * Focused on DS compliance use cases:
 * inspection, drift detection, and annotation.
 * All skills require the Guardian Figma plugin bridge to be active.
 */

import type { Skill } from "../types.js"

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "get_selection_context",
    description:
      "Get a full snapshot of the currently selected node(s) in Figma: " +
      "name, type, size, fills, strokes, and bound variables. " +
      "Use this as a first step in any drift or snowflake investigation.",
    category: "ds-inspection",
    params: [],
    codeTemplate: `
const nodes = figma.currentPage.selection;
if (nodes.length === 0) return { error: "No node selected" };
return nodes.map(node => ({
  id: node.id,
  name: node.name,
  type: node.type,
  width: "width" in node ? node.width : undefined,
  height: "height" in node ? node.height : undefined,
  fills: "fills" in node ? node.fills : undefined,
  strokes: "strokes" in node ? node.strokes : undefined,
  opacity: "opacity" in node ? node.opacity : undefined,
  boundVariables: "boundVariables" in node ? node.boundVariables : undefined,
  componentPropertyReferences: "componentPropertyReferences" in node
    ? node.componentPropertyReferences : undefined,
  isComponent: node.type === "COMPONENT",
  isInstance: node.type === "INSTANCE",
}));
    `.trim(),
    source: "builtin",
    version: "0.1.0",
  },

  {
    name: "get_node_variables",
    description:
      "List all design variables (tokens) bound to a specific Figma node. " +
      "Use this to check if a node uses DS token variables or has hardcoded values. " +
      "Requires nodeId from the Figma node inspector.",
    category: "ds-inspection",
    params: [
      {
        name: "nodeId",
        type: "string",
        required: true,
        description: "Figma node ID (e.g. '123:456')",
      },
    ],
    codeTemplate: `
const node = await figma.getNodeByIdAsync("{{nodeId}}");
if (!node) return { error: "Node not found: {{nodeId}}" };
const vars = "boundVariables" in node ? node.boundVariables : {};
const varEntries = Object.entries(vars ?? {}).map(([prop, binding]) => ({
  property: prop,
  variableId: Array.isArray(binding)
    ? binding.map(b => b.id)
    : (binding as any)?.id,
}));
return {
  nodeId: node.id,
  nodeName: node.name,
  nodeType: node.type,
  boundVariables: varEntries,
  hasVariables: varEntries.length > 0,
};
    `.trim(),
    source: "builtin",
    version: "0.1.0",
  },

  {
    name: "detect_token_overrides",
    description:
      "Detect hardcoded (non-token) values on a node's fills, strokes, and effects. " +
      "Flags any color or spacing value that is NOT bound to a DS variable. " +
      "Use this to confirm drift before running guardian_analyze_drift.",
    category: "ds-inspection",
    params: [
      {
        name: "nodeId",
        type: "string",
        required: true,
        description: "Figma node ID to inspect for token overrides",
      },
    ],
    codeTemplate: `
const node = await figma.getNodeByIdAsync("{{nodeId}}");
if (!node) return { error: "Node not found: {{nodeId}}" };
const boundVars = ("boundVariables" in node ? node.boundVariables : {}) ?? {};
const boundProps = new Set(Object.keys(boundVars));
const overrides = [];
if ("fills" in node && Array.isArray(node.fills)) {
  node.fills.forEach((fill, i) => {
    if (fill.type === "SOLID" && !boundProps.has("fills")) {
      overrides.push({
        property: \`fills[\${i}]\`,
        type: "hardcoded_color",
        value: fill.color,
        tokenBound: false,
      });
    }
  });
}
if ("strokes" in node && Array.isArray(node.strokes)) {
  node.strokes.forEach((stroke, i) => {
    if (stroke.type === "SOLID" && !boundProps.has("strokes")) {
      overrides.push({
        property: \`strokes[\${i}]\`,
        type: "hardcoded_color",
        value: stroke.color,
        tokenBound: false,
      });
    }
  });
}
return {
  nodeId: node.id,
  nodeName: node.name,
  overrides,
  driftDetected: overrides.length > 0,
  summary: overrides.length > 0
    ? \`\${overrides.length} hardcoded value(s) found — token drift likely\`
    : "All visual properties are token-bound or empty",
};
    `.trim(),
    source: "builtin",
    version: "0.1.0",
  },

  {
    name: "get_component_master",
    description:
      "For a selected component instance, find its master component and return " +
      "the master's name, key, and whether the instance has overrides. " +
      "Use this to check if an instance is detached or modified from its master.",
    category: "ds-inspection",
    params: [
      {
        name: "nodeId",
        type: "string",
        required: true,
        description: "Figma node ID of the component instance",
      },
    ],
    codeTemplate: `
const node = await figma.getNodeByIdAsync("{{nodeId}}");
if (!node) return { error: "Node not found: {{nodeId}}" };
if (node.type !== "INSTANCE") {
  return { error: \`Node is not a component instance (type: \${node.type})\` };
}
const master = await node.getMainComponentAsync();
if (!master) return { error: "Could not resolve master component (possibly detached)" };
return {
  instanceId: node.id,
  instanceName: node.name,
  masterId: master.id,
  masterName: master.name,
  masterKey: master.key,
  isRemote: master.remote,
  overriddenProperties: Object.keys(node.overrides ?? {}),
  hasOverrides: Object.keys(node.overrides ?? {}).length > 0,
  detached: false,
};
    `.trim(),
    source: "builtin",
    version: "0.1.0",
  },

  {
    name: "get_ds_variables",
    description:
      "List all local design variables (tokens) in the current Figma file, " +
      "grouped by collection. Use this to understand what tokens are available " +
      "in the DS before checking for drift or missing tokens.",
    category: "ds-inspection",
    params: [
      {
        name: "filterName",
        type: "string",
        required: false,
        description: "Optional filter: only return variables whose name contains this string",
        default: "",
      },
    ],
    codeTemplate: `
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const allVars = await figma.variables.getLocalVariablesAsync();
const filter = "{{filterName}}";
const filtered = filter
  ? allVars.filter(v => v.name.toLowerCase().includes(filter.toLowerCase()))
  : allVars;
const grouped = collections.map(col => ({
  collectionId: col.id,
  collectionName: col.name,
  modes: col.modes,
  variables: filtered
    .filter(v => v.variableCollectionId === col.id)
    .map(v => ({
      id: v.id,
      name: v.name,
      type: v.resolvedType,
      description: v.description,
    })),
})).filter(col => col.variables.length > 0);
return {
  totalCollections: collections.length,
  totalVariables: filtered.length,
  collections: grouped,
};
    `.trim(),
    source: "builtin",
    version: "0.1.0",
  },

  {
    name: "annotate_drift",
    description:
      "Add a visible drift warning annotation near a node on the Figma canvas. " +
      "Creates a sticky note-style frame with a '⚠️ Guardian: Drift detected' label. " +
      "Use this after confirming drift to make it visible to the designer.",
    category: "ds-annotation",
    params: [
      {
        name: "nodeId",
        type: "string",
        required: true,
        description: "Figma node ID to annotate",
      },
      {
        name: "message",
        type: "string",
        required: false,
        description: "Custom annotation message (default: 'Drift detected — check DS token usage')",
        default: "Drift detected — check DS token usage",
      },
    ],
    codeTemplate: `
const node = await figma.getNodeByIdAsync("{{nodeId}}");
if (!node || !("x" in node)) return { error: "Node not found or not positionable" };
const msg = "{{message}}" || "Drift detected — check DS token usage";
const frame = figma.createFrame();
frame.name = "⚠️ Guardian Annotation";
frame.resize(220, 48);
frame.x = node.x + (node.width ?? 0) + 8;
frame.y = node.y;
frame.fills = [{ type: "SOLID", color: { r: 1, g: 0.93, b: 0.58 } }];
frame.cornerRadius = 6;
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
const text = figma.createText();
text.fontName = { family: "Inter", style: "Regular" };
text.characters = \`⚠️ \${msg}\`;
text.fontSize = 11;
text.resize(204, 36);
text.x = 8;
text.y = 6;
frame.appendChild(text);
if (node.parent) node.parent.appendChild(frame);
return {
  annotationId: frame.id,
  annotatedNodeId: node.id,
  annotatedNodeName: node.name,
  message: msg,
};
    `.trim(),
    source: "builtin",
    version: "0.1.0",
  },
]
