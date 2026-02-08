#!/usr/bin/env bash
# Mock Claude CLI binary for end-to-end testing.
# Mimics `claude -p <prompt> --output-format json` output format.
#
# Reads the -p argument from the command line, then returns a valid
# JSON response with result text and token usage. Supports different
# responses based on prompt content.

set -e

# Parse arguments to extract the prompt
PROMPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p)
      PROMPT="$2"
      shift 2
      ;;
    --output-format|--model|--permission-mode|--max-budget-usd)
      shift 2
      ;;
    --no-session-persistence)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ -z "$PROMPT" ]; then
  echo "Error: No prompt provided (-p flag required)" >&2
  exit 1
fi

# Calculate mock token counts based on prompt length
INPUT_TOKENS=$(( ${#PROMPT} / 4 + 10 ))
OUTPUT_TOKENS=$(( INPUT_TOKENS / 2 + 5 ))
CACHE_READ=50
CACHE_CREATION=20

# Determine response based on prompt content
if echo "$PROMPT" | grep -qi "echo:"; then
  # Echo mode: return the text after "echo:" as the result
  RESULT=$(echo "$PROMPT" | sed -n 's/.*echo:\s*//p')
elif echo "$PROMPT" | grep -qi "error"; then
  # Error mode: exit with non-zero to simulate failure
  echo "Simulated provider error" >&2
  exit 1
elif echo "$PROMPT" | grep -qi "analyze"; then
  RESULT="Analysis complete. The input contains structured data with multiple fields."
elif echo "$PROMPT" | grep -qi "summarize"; then
  RESULT="Summary: The provided content has been summarized into key points."
elif echo "$PROMPT" | grep -qi "count"; then
  RESULT="Count result: 42 items found."
else
  # Default: echo back a processed version of the prompt
  RESULT="Processed: ${PROMPT:0:200}"
fi

# Escape the result for JSON (handle quotes, newlines, backslashes)
ESCAPED_RESULT=$(printf '%s' "$RESULT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null || printf '%s' "$RESULT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g; s/\t/\\t/g; s/\r/\\r/g')

# Output valid Claude CLI JSON format
cat <<JSONEOF
{
  "result": "${ESCAPED_RESULT}",
  "session_id": "mock-session-$(date +%s%N | cut -c1-13)",
  "num_turns": 1,
  "duration_ms": 150,
  "total_cost_usd": 0.001,
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": ${INPUT_TOKENS},
      "outputTokens": ${OUTPUT_TOKENS},
      "cacheReadInputTokens": ${CACHE_READ},
      "cacheCreationInputTokens": ${CACHE_CREATION}
    }
  }
}
JSONEOF
