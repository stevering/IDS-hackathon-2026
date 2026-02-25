/**
 * Guardian business logic — public API
 *
 * Exposes the playbooks directly. Each MCP tool accesses its playbook
 * directly from PLAYBOOKS — no routing layer needed.
 */

export { PLAYBOOKS } from "./playbooks.js"
export type {
  QuestionCategory,
  Playbook,
  InvestigationStep,
  AvailableTool,
  ActionType,
} from "./playbooks.js"
