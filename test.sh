#!/usr/bin/env bash
#
# Runs the overdue-task log on demand against the deployed worker, via the
# runLogOverdueTasks tool (same logic as the logOverdueTasks workflow).
#
#   ./test.sh          dry run — reads Notion, writes nothing, posts nothing
#   ./test.sh --write  real run — creates log rows and posts to Slack
#
# Why a tool: as of ntn 0.23.13, `ntn workers exec` refuses schedule-only
# workflows ("does not declare workflow.manual"), and `exec --local` still
# needs a classic src/index.ts. Deploy first (`ntn workers deploy`); the
# deployed worker needs NOTION_API_TOKEN and SLACK_API_KEY pushed.
set -euo pipefail

case "${1:-}" in
	--write)
		echo "Real run against the deployed worker (writes log rows, posts to Slack)."
		ntn workers exec runLogOverdueTasks -d '{"dryRun": false}'
		;;
	*)
		echo "Dry run against the deployed worker — writes nothing."
		ntn workers exec runLogOverdueTasks -d '{"dryRun": true}'
		;;
esac
