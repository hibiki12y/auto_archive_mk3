#!/bin/bash
cd /home/deepsky/workspace/auto_archive_mk3
TOKEN=$(grep '^AUTO_ARCHIVE_DISCORD_TOKEN=' .env | cut -d= -f2-)
LOG="$(pwd)/wu2-discord-poll.log"
AR=1476113538320957451
PL=1494347028971655238
START=$(date +%s)
MAX=$((START + 45*60))
NUDGED=0
while [ "$(date +%s)" -lt "$MAX" ]; do
  NOW=$(date -u +%FT%TZ)
  RESP=$(curl -sS -H "Authorization: Bot $TOKEN" "https://discord.com/api/v10/channels/1483826614335836170/messages?limit=30")
  echo "=== POLL $NOW ===" >> "$LOG"
  echo "$RESP" | jq -r --arg AR "$AR" --arg PL "$PL" '.[] | select(.author.id==$AR or .author.id==$PL) | "\(.timestamp) [\(.author.username)|\(.author.id)] \(.content[0:600])"' >> "$LOG"
  # Success check: ONLY consider arona-authored EVIDENCE lines with concrete values (not <id>/<url> placeholders)
  if echo "$RESP" | jq -r --arg AR "$AR" '.[] | select(.author.id==$AR) | .content' | grep -E 'EVIDENCE: SLURM_JOB_ID=[0-9]+' >/dev/null 2>&1; then
    echo "=== DETECTED ARONA EVIDENCE at $NOW ===" >> "$LOG"
    touch .wu2/evidence_found
    break
  fi
  ELAPSED=$(( $(date +%s) - START ))
  if [ "$ELAPSED" -gt 900 ] && [ "$NUDGED" -eq 0 ]; then
    echo "=== NUDGE TRIGGERED at $NOW ===" >> "$LOG"
    NUDGED=1
    touch .wu2/nudge_needed
  fi
  sleep 60
done
echo "=== POLL LOOP END $(date -u +%FT%TZ) ===" >> "$LOG"
