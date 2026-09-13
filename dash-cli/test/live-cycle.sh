#!/usr/bin/env bash
# Phase 1 acceptance test: full launch cycle, no TTY required.
#
#   1. snapshots the currently running launch config (if any)
#   2. stops it
#   3. boots the small 7B test model via /api/start (same payload shape the
#      TUI's Launch mode sends)
#   4. sends ONE no-thinking chat request to :8080 and checks the answer
#   5. verifies the request landed in the benchmark CSV
#   6. stops the test model
#   7. restores the original launch config (exact same payload)
#
# Usage:  bash test/live-cycle.sh [dashboard-url]
# Default dashboard: http://localhost:3000
#
# NOTE: this stops whatever model is running for ~1-2 minutes. Run it when
# nothing else needs the model.

set -euo pipefail
DASH="${1:-http://localhost:3000}"
DASH="${DASH%/}"
MODEL_PORT=8080
TEST_MODEL="/home/kyle/AI/experiment-1/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
TEST_BUILD="vulkan-cuda"
SNAP="$(mktemp -d)"
trap 'rm -rf "$SNAP"' EXIT

say() { printf '\n\033[1;34m[live-cycle]\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m[live-cycle] FAIL:\033[0m %s\n' "$1"; exit 1; }

[ -f "$TEST_MODEL" ] || fail "test model not found: $TEST_MODEL"

sse_state() {
  # fresh SSE connection -> immediate current-state frame
  curl -s -N -m 5 "$DASH/api/status" | head -1 | sed 's/^data: //'
}

wait_state() { # $1=expected $2=timeout_s
  local want="$1" t="$2" i
  for ((i = 0; i < t; i++)); do
    sleep 1
    local st
    st=$(sse_state | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""))' 2>/dev/null || echo "")
    [ "$st" = "$want" ] && return 0
  done
  return 1
}

say "dashboard: $DASH"
sse_state > /dev/null || fail "cannot reach $DASH/api/status (is the dashboard running?)"

# 1. snapshot current config
CUR=$(sse_state)
RUNNING_CFG=$(printf '%s' "$CUR" | python3 -c '
import json, sys
d = json.load(sys.stdin)
cfg = d.get("launchConfig")
if d.get("state") not in ("stopped", "stopping") and cfg:
    print(json.dumps(cfg))
' 2>/dev/null || true)
if [ -n "$RUNNING_CFG" ]; then
  printf '%s' "$RUNNING_CFG" > "$SNAP/launch-config.json"
  say "snapshotted running config for restore: $(python3 -c 'import json; print(json.load(open("'"$SNAP"'/launch-config.json"))["modelPath"].split("/")[-1])')"
else
  say "no model running; nothing to restore"
fi

# 2. stop
STATE=$(printf '%s' "$CUR" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
if [ "$STATE" != "stopped" ]; then
  say "stopping current model (state: $STATE)"
  curl -s -m 10 -X POST "$DASH/api/stop" > /dev/null
  wait_state stopped 60 || fail "model did not stop within 60s"
fi

# 3. boot test model (structured config -- exactly what the TUI sends)
say "booting test model: $(basename "$TEST_MODEL")"
START_RESP=$(curl -s -m 15 -X POST "$DASH/api/start" -H 'Content-Type: application/json' -d "{
  \"modelPath\": \"$TEST_MODEL\",
  \"build\": \"$TEST_BUILD\",
  \"ctx\": 8192,
  \"ngl\": 99,
  \"port\": $MODEL_PORT
}")
printf '%s' "$START_RESP" | grep -q '"launching"' || fail "start rejected: $START_RESP"
wait_state ready 180 || fail "test model did not reach ready within 180s"
say "test model ready"

# 4. one no-thinking request (the test model is not a thinker, but /no_think
#    keeps the prompt minimal regardless)
ANSWER=$(curl -s -m 60 "http://localhost:$MODEL_PORT/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"test","messages":[{"role":"user","content":"/no_think Reply with exactly: TUI-TEST-OK"}],"max_tokens":64,"temperature":0}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["choices"][0]["message"]["content"])' 2>/dev/null || echo "")
say "model answered: $(printf '%s' "$ANSWER" | head -c 80)"
printf '%s' "$ANSWER" | grep -q "TUI-TEST-OK" || fail "expected TUI-TEST-OK in answer, got: $ANSWER"

# 5. verify the CSV row
sleep 1
ROW=$(curl -s -m 5 "$DASH/api/logs/recent?limit=1")
printf '%s' "$ROW" | python3 -c '
import json, sys
row = json.load(sys.stdin)["rows"][-1]
name = row["model"]
assert name == "'"$(basename "$TEST_MODEL")"'", f"unexpected model in CSV: {name}"
assert (row.get("genTokens") or 0) > 0, "no gen tokens recorded"
print("csv row ok:", row["timestamp"], name, "genTps", row["genTps"])
' || fail "CSV row missing or wrong after test request"

# 6. stop test model
say "stopping test model"
curl -s -m 10 -X POST "$DASH/api/stop" > /dev/null
wait_state stopped 60 || fail "test model did not stop within 60s"

# 7. restore
if [ -s "$SNAP/launch-config.json" ]; then
  say "restoring original model"
  RESTORE_RESP=$(curl -s -m 15 -X POST "$DASH/api/start" -H 'Content-Type: application/json' \
    -d @"$SNAP/launch-config.json")
  printf '%s' "$RESTORE_RESP" | grep -q '"launching"' || fail "restore rejected: $RESTORE_RESP"
  wait_state ready 300 || fail "original model did not come back within 300s"
  say "original model restored"
fi

printf '\n\033[1;32m[live-cycle] PASS: full launch cycle verified\033[0m\n'
