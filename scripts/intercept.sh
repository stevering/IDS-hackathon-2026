#!/bin/bash
# Intercept helper — simplifies SSE + PostgREST flow
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export $(grep -v '^#' "$SCRIPT_DIR/.env.local" | grep STORAGE_SUPABASE_SERVICE_ROLE_KEY | xargs)
KEY="$STORAGE_SUPABASE_SERVICE_ROLE_KEY"
USER_ID="6285962c-02a9-4c20-92e0-9d144de99630"
BASE="https://ookghxkvzdnqicjdslej.supabase.co/rest/v1/intercept_queue"
STREAM="http://localhost:3000/api/intercept/stream"
HDRS=(-H "apikey: $KEY" -H "Authorization: Bearer $KEY")

cmd="${1:-help}"
shift || true

case "$cmd" in
  # Poll pending intercepts
  poll)
    curl -s "$BASE?user_id=eq.$USER_ID&status=eq.pending&select=request_id,purpose,agent_short_id,step_count&order=created_at" "${HDRS[@]}" \
      | python3 -c "
import json,sys
data=json.load(sys.stdin)
if not data:
    print('0 pending')
else:
    for r in data:
        print(f'{r[\"request_id\"]} | {r[\"purpose\"]} | {r.get(\"agent_short_id\") or \"-\"} | step {r.get(\"step_count\") if r.get(\"step_count\") is not None else \"-\"}')
    if len(data) > 1:
        print(f'[PERF] {len(data)} pending — Write JSON files in parallel, then: ./scripts/intercept.sh batch \"send id1 tmp/f1.json\" \"ack id2 msg\"')
"
    ;;

  # Respond to an intercept: ./intercept.sh respond <request_id> <json_file_or_content>
  respond)
    rid="$1"; shift
    if [[ -f "$1" ]]; then
      curl -s -o /dev/null -w "%{http_code} %{time_total}s" -X PATCH "$BASE?request_id=eq.$rid" "${HDRS[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" -d @"$1"
    else
      curl -s -o /dev/null -w "%{http_code} %{time_total}s" -X PATCH "$BASE?request_id=eq.$rid" "${HDRS[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "$1"
    fi
    echo ""
    ;;

  # Quick approve (code_review/file_review)
  approve)
    for rid in "$@"; do
      curl -s -o /dev/null -w "$rid: %{http_code} %{time_total}s\n" -X PATCH "$BASE?request_id=eq.$rid" "${HDRS[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
        -d '{"status":"responded","response_content":"APPROVED","responded_by":"claude_code_sse","responded_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' &
    done
    wait
    ;;

  # Quick verify (file_review)
  verify)
    for rid in "$@"; do
      curl -s -o /dev/null -w "$rid: %{http_code} %{time_total}s\n" -X PATCH "$BASE?request_id=eq.$rid" "${HDRS[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
        -d '{"status":"responded","response_content":"VERIFIED: Execution result accepted.","responded_by":"claude_code_sse","responded_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' &
    done
    wait
    ;;

  # SSE listen — blocks until first event, outputs JSON
  listen)
    # 2>/dev/null suppresses curl broken pipe error; || true ensures exit 0
    event=$(curl -s -N \
      -H "x-mcp-service-key: $KEY" \
      -H "x-mcp-user-id: $USER_ID" \
      "$STREAM" 2>/dev/null | grep -m 1 '^data:' | sed 's/^data: //' || true)
    echo "$event"
    echo ""
    echo "[NEXT] 1) Process the event above  2) Relaunch pollwait in background"
    echo "[PERF] Write JSON files in parallel, then: ./scripts/intercept.sh batch \"send id tmp/f.json\" \"ack id msg\""
    ;;

  # Poll-wait: check DB first (catch gap), then SSE push (no polling)
  pollwait)
    # Step 1: check DB for already-pending intercepts (SSE gap)
    result=$(curl -s "$BASE?user_id=eq.$USER_ID&status=eq.pending&select=request_id,purpose,agent_short_id,step_count&order=created_at" "${HDRS[@]}")
    count=$(echo "$result" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
    if [ "$count" -gt 0 ]; then
      echo "$result" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for r in data:
    print(f'{r[\"request_id\"]} | {r[\"purpose\"]} | {r.get(\"agent_short_id\") or \"-\"} | step {r.get(\"step_count\") if r.get(\"step_count\") is not None else \"-\"}')
if len(data) > 1:
    print(f'[PERF] {len(data)} pending — Write JSON files in parallel, then: ./scripts/intercept.sh batch \"send id1 tmp/f1.json\" \"ack id2 msg\"')
"
      echo "[ACTION] Read output above. Write JSON responses in tmp/, then: ./scripts/intercept.sh batch \"send id tmp/f.json\" \"ack id msg\""
      exit 0
    fi
    # Step 2: nothing pending — wait for SSE push (no polling)
    echo "[SSE] No pending — waiting for push..."
    event=$(curl -s -N \
      -H "x-mcp-service-key: $KEY" \
      -H "x-mcp-user-id: $USER_ID" \
      "$STREAM" 2>/dev/null | grep -m 1 '^data:' | sed 's/^data: //' || true)
    # Step 3: SSE event received — re-check DB (event may have peers)
    result=$(curl -s "$BASE?user_id=eq.$USER_ID&status=eq.pending&select=request_id,purpose,agent_short_id,step_count&order=created_at" "${HDRS[@]}")
    echo "$result" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for r in data:
    print(f'{r[\"request_id\"]} | {r[\"purpose\"]} | {r.get(\"agent_short_id\") or \"-\"} | step {r.get(\"step_count\") if r.get(\"step_count\") is not None else \"-\"}')
if len(data) > 1:
    print(f'[PERF] {len(data)} pending — Write JSON files in parallel, then: ./scripts/intercept.sh batch \"send id1 tmp/f1.json\" \"ack id2 msg\"')
"
    echo "[ACTION] Read output above. Write JSON responses in tmp/, then: ./scripts/intercept.sh batch \"send id tmp/f.json\" \"ack id msg\""
    ;;

  # Signal task complete: ./intercept.sh done <id> "summary text"
  done)
    rid="$1"; shift
    summary="$*"
    curl -s -o /dev/null -w "$rid: %{http_code} %{time_total}s" -X PATCH "$BASE?request_id=eq.$rid" "${HDRS[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
      -d "{\"status\":\"responded\",\"response_content\":\"Task complete.\",\"response_tool_calls\":[{\"id\":\"tc-1\",\"name\":\"signal_task_complete\",\"arguments\":{\"summary\":\"$summary\"}}],\"responded_by\":\"claude_code_sse\",\"responded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    echo ""
    ;;

  # Mark agent done (orchestrator): ./intercept.sh markdone <id> <agentShortId>
  markdone)
    rid="$1"; agent="$2"
    curl -s -o /dev/null -w "$rid: %{http_code} %{time_total}s" -X PATCH "$BASE?request_id=eq.$rid" "${HDRS[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
      -d "{\"status\":\"responded\",\"response_content\":\"Agent done.\",\"response_tool_calls\":[{\"id\":\"tc-1\",\"name\":\"mark_agent_done\",\"arguments\":{\"agentShortId\":\"$agent\"}}],\"responded_by\":\"claude_code_sse\",\"responded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    echo ""
    ;;

  # Respond with file: ./intercept.sh send <id> <file.json>
  send)
    rid="$1"; file="$2"
    curl -s -o /dev/null -w "$rid: %{http_code} %{time_total}s" -X PATCH "$BASE?request_id=eq.$rid" "${HDRS[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" -d @"$file"
    echo ""
    ;;

  # Acknowledge orchestrator (no tools): ./intercept.sh ack <id> "message"
  ack)
    rid="$1"; shift
    msg="$*"
    curl -s -o /dev/null -w "$rid: %{http_code} %{time_total}s" -X PATCH "$BASE?request_id=eq.$rid" "${HDRS[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
      -d "{\"status\":\"responded\",\"response_content\":\"$msg\",\"responded_by\":\"claude_code_sse\",\"responded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    echo ""
    ;;

  # Batch: run multiple commands in parallel
  # Usage: ./scripts/intercept.sh batch "send id1 tmp/f1.json" "ack id2 msg" "done id3 summary"
  batch)
    for subcmd in "$@"; do
      # shellcheck disable=SC2086
      "$0" $subcmd &
    done
    wait
    ;;

  # Full status of recent intercepts
  status)
    curl -s "$BASE?user_id=eq.$USER_ID&created_at=gte.$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)&select=request_id,purpose,agent_short_id,status,step_count,created_at&order=created_at" "${HDRS[@]}" \
      | python3 -c "
import json,sys
for r in json.load(sys.stdin):
    t=r['created_at'][11:19]; s=r['status'] or '-'; p=r['purpose'] or '-'
    a=r.get('agent_short_id') or '-'; st=r.get('step_count'); st=str(st) if st is not None else '-'
    print(f'{t} | {s:10} | {p:13} | {a:25} | step {st}')
"
    ;;

  *)
    echo "Usage: ./scripts/intercept.sh <command> [args]"
    echo ""
    echo "  poll                         — list pending intercepts (instant)"
    echo "  pollwait                     — block until pending intercepts exist"
    echo "  listen                       — SSE block until first event (push)"
    echo "  approve <id> [<id>...]       — APPROVED (code_review)"
    echo "  verify <id> [<id>...]        — VERIFIED (file_review)"
    echo "  done <id> \"summary\"          — signal_task_complete"
    echo "  markdone <id> #agent         — mark_agent_done"
    echo "  ack <id> \"message\"           — orchestrator ack (no tools)"
    echo "  send <id> <file.json>        — respond with JSON file"
    echo "  batch \"cmd1\" \"cmd2\" ...      — run multiple commands in parallel"
    echo "  status                       — recent intercept timeline"
    ;;
esac

# After any response command, remind to relaunch pollwait
case "$cmd" in
  approve|verify|done|markdone|ack|send|batch)
    echo "[NEXT] Relaunch: ./scripts/intercept.sh pollwait (in background)"
    ;;
esac
