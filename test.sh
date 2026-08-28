#!/usr/bin/env bash
#
# Drives the logOverdueTasks workflow with a synthetic recurrence event.
#
#   ./test.sh              dry run locally — reads Notion, writes nothing
#   ./test.sh --write      real run locally — creates log rows
#   ./test.sh --remote     real run against the deployed worker
#
# Local runs load .env automatically (needs NOTION_API_TOKEN). For remote runs,
# push the token first with `ntn workers env push`.
#
# NOTE: as of ntn 0.22.10, `ntn workers exec --local` looks for a classic
# src/index.ts entry point and does not yet discover alpha file-based
# workflows under src/workflows/. Until that lands, --local and --write below
# will fail with "Could not find src/index.ts" — use --remote after
# `ntn workers deploy` (and `ntn workers env push`) instead. Set DRY_RUN=1 via
# `ntn workers env push` first to do a safe remote dry run.
set -euo pipefail

# The recurrence trigger's real schedule is configured in the Notion UI; this
# payload just mimics the event the runtime delivers.
EVENT='{
  "type": "recurrence",
  "vendor": "notion",
  "frequency": "day",
  "interval": 1,
  "timezone": "America/Argentina/Buenos_Aires",
  "message": "Scheduled run",
  "actor": null,
  "timestamp": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
}'

case "${1:-}" in
	--remote)
		echo "Running against the deployed worker (this writes log rows)."
		ntn workers exec logOverdueTasks -d "$EVENT"
		;;
	--write)
		echo "Running locally (this writes log rows)."
		ntn workers exec logOverdueTasks --local -d "$EVENT"
		;;
	*)
		echo "Dry run — reads Notion, writes nothing."
		DRY_RUN=1 ntn workers exec logOverdueTasks --local -d "$EVENT"
		;;
esac
