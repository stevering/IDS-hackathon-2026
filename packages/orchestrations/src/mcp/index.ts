/** Barrel for the MCP registry + bridge protocol shared across packages. */
// Extensionless imports — Turbopack cannot resolve .js→.ts for new files in workspace packages.
export * from "./registry";
export * from "./bridge-protocol";
export * from "./tool-groups";
