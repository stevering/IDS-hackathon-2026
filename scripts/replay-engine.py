#!/usr/bin/env python3
"""
Replay engine for orchestration LLM intercepts.

Automatically responds to intercepts using pre-recorded scenario templates.
Matches by (purpose, agent role, step) with dynamic substitution of:
- Agent short IDs (discovered at runtime from first orchestrator intercept)
- Node IDs (captured from execution results)
- Timestamps

Usage:
    python3 scripts/replay-engine.py scripts/replay-collab-scenario-templates/mini-design-system [--dry-run] [--verbose]
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ─── Config ──────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent.parent
INTERCEPT_SH = SCRIPT_DIR / "scripts" / "intercept.sh"
TMP_DIR = SCRIPT_DIR / "tmp"

# ─── State ───────────────────────────────────────────────────────────────────

agent_role_map = {}       # "#Figma-Desktop-pomipo" -> "A"
agent_suffix_map = {}     # "A" -> "#Figma-Desktop-pomipo"
node_id_registry = {}     # "C:0" -> "39:90" (role:step -> node ID)
agents_done = set()       # roles marked done
agent_step_tracker = {}   # role -> current expected step index for "done" detection
all_node_ids_by_role = {} # role -> [list of all node IDs captured]

# ─── Template Loading ────────────────────────────────────────────────────────

def load_scenario(scenario_dir):
    """Load scenario.json and all templates from the templates/ dir."""
    scenario_path = Path(scenario_dir) / "scenario.json"
    with open(scenario_path) as f:
        scenario = json.load(f)

    templates = {}
    templates_dir = Path(scenario_dir) / "templates"
    for tpl_file in sorted(templates_dir.glob("*.json")):
        with open(tpl_file) as f:
            tpl = json.load(f)
        key = tpl_file.stem  # e.g. "agent-A__step-0"
        templates[key] = tpl

    return scenario, templates


# ─── Agent Discovery ─────────────────────────────────────────────────────────

def discover_agents(payload, scenario):
    """Extract agent short IDs from first orchestrator payload and map to roles."""
    global agent_role_map, agent_suffix_map

    # Parse agents from system message: "- #Figma-Desktop-XXX (..."
    messages = payload.get("messages", [])
    system_msg = ""
    for m in messages:
        if m.get("role") == "system":
            system_msg = m.get("content", "")
            break

    agent_ids = re.findall(r"(#Figma-Desktop-\w+)", system_msg)
    # Deduplicate while preserving order
    seen = set()
    unique_ids = []
    for aid in agent_ids:
        if aid not in seen:
            seen.add(aid)
            unique_ids.append(aid)

    roles = sorted(scenario.get("agentRoles", {}).keys())
    for i, role in enumerate(roles):
        if i < len(unique_ids):
            agent_suffix_map[role] = unique_ids[i]
            agent_role_map[unique_ids[i]] = role

    print(f"  [AGENTS] Discovered mapping:")
    for role, agent_id in agent_suffix_map.items():
        label = scenario.get("agentRoles", {}).get(role, {}).get("label", "")
        print(f"    {role} = {agent_id} ({label})")


# ─── Node ID Extraction ─────────────────────────────────────────────────────

def extract_node_ids(payload):
    """Extract node IDs from tool results in the payload messages."""
    role = agent_role_map.get(payload.get("agent", ""))
    if not role:
        return

    messages = payload.get("messages", [])
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            # Pattern: Created node IDs: ["123:456"]
            match = re.search(r'Created node IDs?:\s*\[([^\]]+)\]', content)
            if match:
                ids_str = match.group(1)
                ids = re.findall(r'"(\d+:\d+)"', ids_str)
                for node_id in ids:
                    # Determine which step this came from
                    step = payload.get("step", "0")
                    try:
                        step_num = int(step) - 1  # Result is from previous step
                    except (ValueError, TypeError):
                        step_num = 0
                    key = f"{role}:{step_num}"
                    if key not in node_id_registry:
                        node_id_registry[key] = node_id
                        if role not in all_node_ids_by_role:
                            all_node_ids_by_role[role] = []
                        all_node_ids_by_role[role].append(node_id)
                        print(f"  [NODE] Captured {key} = {node_id}")

            # Also look for ID in return value: {"result":"123:456"}
            match = re.search(r'"result"\s*:\s*"(\d+:\d+)"', content)
            if match:
                node_id = match.group(1)
                step = payload.get("step", "0")
                try:
                    step_num = int(step) - 1
                except (ValueError, TypeError):
                    step_num = 0
                key = f"{role}:{step_num}"
                if key not in node_id_registry:
                    node_id_registry[key] = node_id
                    if role not in all_node_ids_by_role:
                        all_node_ids_by_role[role] = []
                    all_node_ids_by_role[role].append(node_id)
                    print(f"  [NODE] Captured {key} = {node_id}")


# ─── Matching ────────────────────────────────────────────────────────────────

def detect_state(payload):
    """Analyze payload to determine the intercept state."""
    messages = payload.get("messages", [])
    if not messages:
        return "unknown"

    last_msg = messages[-1]
    last_content = last_msg.get("content", "")
    if isinstance(last_content, list):
        # Extract text from content blocks
        for part in reversed(last_content):
            if isinstance(part, dict) and part.get("type") == "text":
                last_content = part["text"]
                break
        else:
            last_content = str(last_content)

    last_role = last_msg.get("role", "")

    # Agent states
    if payload["purpose"] == "agent":
        if "[Broadcast from" in last_content:
            return "broadcast"
        if "[Orchestrator task]" in last_content:
            return "initial-directive"
        if "Execution succeeded" in last_content:
            return "post-execution-success"
        if "Execution failed" in last_content:
            return "post-execution-fail"

    # Orchestrator states
    if payload["purpose"] == "orchestrator":
        msg_count = len(messages)
        if msg_count <= 2:
            return "init"

        # Check for agent done reports
        if "DIRECTIVE DONE" in last_content or "task_complete" in last_content.lower() or "task complete" in last_content.lower():
            return "agent-report-done"

        # Check if all agents are done (look for mark_agent_done results)
        done_count = sum(1 for m in messages if "marked as done" in m.get("content", ""))
        role_count = len(agent_suffix_map)
        if done_count >= role_count and role_count > 0:
            return "all-done"

        return "waiting"

    return "unknown"


def match_template(payload, templates, scenario):
    """Find the best matching template for this intercept."""
    purpose = payload["purpose"]
    agent = payload.get("agent", "-")
    step = payload.get("step", "-")
    role = agent_role_map.get(agent)
    state = detect_state(payload)
    exec_stats = payload.get("exec_stats", {})

    # Code review and file review: auto-handle
    if purpose == "code_review":
        return "APPROVE", state
    if purpose == "file_review":
        if state == "post-execution-fail":
            return "ISSUE", state
        return "VERIFY", state

    # Agent: broadcast ack
    if purpose == "agent" and state == "broadcast":
        return templates.get("agent__broadcast-ack"), state

    # Agent: specific role + step
    if purpose == "agent" and role:
        # Track the highest successful step for each role
        if role not in agent_step_tracker:
            agent_step_tracker[role] = -1

        if state == "initial-directive":
            # Step 0: first directive
            key = f"agent-{role}__step-0"
            agent_step_tracker[role] = 0
            if key in templates:
                return templates[key], state

        elif state == "post-execution-success":
            # After successful execution, go to next step or done
            current_step = agent_step_tracker.get(role, 0)
            next_step = current_step + 1
            next_key = f"agent-{role}__step-{next_step}"
            if next_key in templates:
                agent_step_tracker[role] = next_step
                return templates[next_key], state
            else:
                # No more steps -> signal done
                done_key = f"agent-{role}__done"
                if done_key in templates:
                    return templates[done_key], "done"

        elif state == "post-execution-fail":
            # Retry same step (the template code already has the fix baked in)
            current_step = agent_step_tracker.get(role, 0)
            key = f"agent-{role}__step-{current_step}"
            if key in templates:
                return templates[key], "retry"

    # Orchestrator
    if purpose == "orchestrator":
        if state == "init":
            return templates.get("orchestrator__init"), state
        if state == "agent-report-done":
            return templates.get("orchestrator__agent-done"), state
        if state == "all-done":
            return templates.get("orchestrator__final"), state
        return templates.get("orchestrator__ack"), state

    return None, state


# ─── Substitution ────────────────────────────────────────────────────────────

def substitute(template, payload):
    """Replace placeholders in template with runtime values."""
    text = json.dumps(template)

    # Timestamp
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    text = text.replace("{{TIMESTAMP}}", ts)

    # Agent placeholders
    for role, agent_id in agent_suffix_map.items():
        text = text.replace(f"{{{{AGENT_{role}}}}}", agent_id)

    # Node ID placeholders: {{NODE_C_0}} -> the node ID from role C step 0
    for key, node_id in node_id_registry.items():
        role, step_str = key.split(":")
        placeholder = f"{{{{NODE_{role}_{step_str}}}}}"
        text = text.replace(placeholder, node_id)

    # Dynamic: mark_agent_done — find which agent reported done
    if '"_dynamic": "mark_agent_done"' in text or '"_dynamic":"mark_agent_done"' in text:
        done_agent = detect_done_agent(payload)
        text = text.replace("{{DONE_AGENT}}", done_agent)

    # Dynamic: signal_task_complete_with_node_ids — inject captured node IDs
    if "signal_task_complete_with_node_ids" in text:
        role = agent_role_map.get(payload.get("agent", ""))
        ids = all_node_ids_by_role.get(role, [])
        # Replace empty nodeIds array with actual IDs
        text = text.replace('"nodeIds": []', f'"nodeIds": {json.dumps(ids)}')

    result = json.loads(text)

    # Remove internal _match and _dynamic keys
    result.pop("_match", None)
    result.pop("_dynamic", None)

    return result


def detect_done_agent(payload):
    """From an orchestrator payload, find which agent reported done."""
    messages = payload.get("messages", [])
    # Scan from the end for an agent report message
    for msg in reversed(messages):
        content = msg.get("content", "")
        if isinstance(content, str):
            # Pattern: [Agent report from ##Figma-Desktop-XXX — ...]
            match = re.search(r'#(#Figma-Desktop-\w+)', content)
            if match:
                agent_id = match.group(1)
                return agent_id
            # Also try without double #
            match = re.search(r'(#Figma-Desktop-\w+)', content)
            if match:
                return match.group(1)
    return "unknown"


# ─── Intercept Runner ────────────────────────────────────────────────────────

def run_intercept(*args, timeout=None):
    """Run intercept.sh with given arguments."""
    cmd = [str(INTERCEPT_SH)] + list(args)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(SCRIPT_DIR), timeout=timeout)
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except subprocess.TimeoutExpired:
        return "", "timeout", -1


def parse_intercept_ids(stdout):
    """Parse intercept IDs from pollwait/poll output."""
    intercept_ids = []
    for line in stdout.split("\n"):
        line = line.strip()
        if line.startswith("intercept-"):
            rid = line.split(" | ")[0].strip()
            intercept_ids.append(rid)
        elif "0 pending" in line:
            return []
    return intercept_ids


def pollwait():
    """Run pollwait with 15s timeout, fallback to poll if SSE blocks."""
    stdout, stderr, rc = run_intercept("pollwait", timeout=15)

    if rc == -1:  # timeout — SSE blocked, fallback to instant poll
        print("  [SSE timeout] Falling back to poll...")
        stdout, stderr, rc = run_intercept("poll")
        if rc != 0:
            return []
        ids = parse_intercept_ids(stdout)
        if not ids:
            # Nothing pending even after timeout — wait a bit and retry
            time.sleep(2)
        return ids

    if rc != 0:
        print(f"  [WARN] pollwait exited {rc}: {stderr}")
        return []

    return parse_intercept_ids(stdout)


def read_payload(intercept_id):
    """Read the payload JSON file written by pollwait."""
    payload_file = TMP_DIR / f"{intercept_id}.payload.json"
    if not payload_file.exists():
        return None
    try:
        with open(payload_file) as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        print(f"  [WARN] Corrupt payload for {intercept_id}: {e}")
        return None


# ─── Main Loop ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/replay-engine.py <scenario-dir> [--dry-run] [--verbose]")
        sys.exit(1)

    scenario_dir = sys.argv[1]
    dry_run = "--dry-run" in sys.argv
    verbose = "--verbose" in sys.argv

    print(f"{'[DRY RUN] ' if dry_run else ''}Loading scenario: {scenario_dir}")
    scenario, templates = load_scenario(scenario_dir)
    print(f"  Loaded {len(templates)} templates")
    print(f"  Roles: {list(scenario.get('agentRoles', {}).keys())}")

    # Create replay work dir
    replay_id = f"replay-{int(time.time())}"
    replay_dir = TMP_DIR / replay_id
    replay_dir.mkdir(parents=True, exist_ok=True)
    print(f"  Work dir: {replay_dir}")

    cycle = 0
    total_intercepts = 0
    discovered = False

    print(f"\n{'='*60}")
    print("Starting replay loop... (Ctrl+C to stop)")
    print(f"{'='*60}\n")

    try:
        while True:
            cycle += 1
            print(f"\n--- Cycle {cycle} ---")

            # Poll for intercepts
            intercept_ids = pollwait()
            if not intercept_ids:
                print("  No pending intercepts. Waiting...")
                time.sleep(2)
                continue

            print(f"  {len(intercept_ids)} pending intercept(s)")

            # Process each intercept
            batch_cmds = []
            for rid in intercept_ids:
                total_intercepts += 1
                payload = read_payload(rid)
                if not payload:
                    print(f"  [SKIP] {rid} — no payload file")
                    continue

                purpose = payload.get("purpose", "?")
                agent = payload.get("agent", "-")
                step = payload.get("step", "-")
                role = agent_role_map.get(agent, "?")

                # Discover agents on first orchestrator call
                if not discovered and purpose == "orchestrator":
                    discover_agents(payload, scenario)
                    discovered = True

                # Extract node IDs from previous execution results
                extract_node_ids(payload)

                # Match template
                template, state = match_template(payload, templates, scenario)
                tag = f"{purpose}/{role}/step{step}/{state}"

                if template == "APPROVE":
                    print(f"  [{rid[:30]}] {tag} -> APPROVE")
                    batch_cmds.append(f"approve {rid}")
                elif template == "VERIFY":
                    print(f"  [{rid[:30]}] {tag} -> VERIFY")
                    batch_cmds.append(f"verify {rid}")
                elif template == "ISSUE":
                    print(f"  [{rid[:30]}] {tag} -> ISSUE (execution failed)")
                    batch_cmds.append(f"verify {rid}")  # Still verify to let the agent retry
                elif template is not None:
                    # Substitute and write response file
                    response = substitute(template, payload)
                    response_file = replay_dir / f"{rid}.json"
                    with open(response_file, "w") as f:
                        json.dump(response, f, indent=2)

                    tpl_name = response.get("response_content", "")[:60]
                    tools = [tc["name"] for tc in response.get("response_tool_calls", [])]
                    tools_str = f" tools=[{','.join(tools)}]" if tools else ""
                    print(f"  [{rid[:30]}] {tag} -> send{tools_str}")

                    if verbose:
                        print(f"    Content: {tpl_name}...")

                    batch_cmds.append(f"send {rid} {response_file}")
                else:
                    print(f"  [{rid[:30]}] {tag} -> NO MATCH (ack)")
                    batch_cmds.append(f"ack {rid} No matching template")

            # Execute batch
            if batch_cmds and not dry_run:
                print(f"\n  Sending batch ({len(batch_cmds)} commands)...")
                stdout, stderr, rc = run_intercept("batch", *batch_cmds)
                if stdout:
                    for line in stdout.split("\n"):
                        if line.strip() and not line.startswith("[NEXT]"):
                            print(f"    {line.strip()}")
            elif dry_run:
                print(f"\n  [DRY RUN] Would send: {batch_cmds}")

            # Check if orchestration is complete
            if len(agents_done) >= len(agent_suffix_map) and len(agent_suffix_map) > 0:
                # Give a few more cycles for the final orchestrator summary
                pass

            print(f"  Node IDs: {dict(node_id_registry)}")
            print(f"  Steps: {dict(agent_step_tracker)}")

    except KeyboardInterrupt:
        print(f"\n\n{'='*60}")
        print(f"Replay stopped after {cycle} cycles, {total_intercepts} intercepts")
        print(f"Agent mapping: {agent_suffix_map}")
        print(f"Node IDs: {node_id_registry}")
        print(f"{'='*60}")


if __name__ == "__main__":
    main()
