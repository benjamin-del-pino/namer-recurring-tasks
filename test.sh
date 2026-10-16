#!/usr/bin/env bash
#
# Runs a workflow's logic on demand against the deployed worker, via its tool.
#
#   ./test.sh                    overdue log, dry run: reads Notion, writes nothing, posts nothing
#   ./test.sh --write            overdue log, real run: creates log rows and posts to Slack
#   ./test.sh --write C123 C456  overdue log, real run, morning posts only to these channels
#   ./test.sh reminders          3PM reminder, dry run: reads Notion, posts nothing
#   ./test.sh reminders --write  3PM reminder, real run: posts to Slack (not deduped)
#   ./test.sh reminders --write C123 C456
#                                3PM reminder, only these channels (finish a run that stopped partway)
#
# Why tools: as of ntn 0.23.13, `ntn workers exec` refuses schedule-only
# workflows ("does not declare workflow.manual"), and `exec --local` still
# needs a classic src/index.ts. Deploy first (`ntn workers deploy`); the
# deployed worker needs SLACK_API_KEY pushed.
set -euo pipefail

tool="runLogOverdueTasks"
label="overdue log"
if [[ "${1:-}" == "reminders" ]]; then
	tool="runSendReminders"
	label="3PM reminder"
	shift
fi
mode="${1:-}"
[[ $# -gt 0 ]] && shift
if [[ $# -gt 0 ]]; then
	extra=", \"channels\": [$(printf '"%s",' "$@" | sed 's/,$//')]"
else
	extra=', "channels": null'
fi
set -- "$mode"

# A long real run can outlast the CLI (504 Gateway Timeout) while it keeps
# going on the platform: check `ntn workers runs list` for the real outcome.
case "${1:-}" in
	--write)
		echo "Real $label run against the deployed worker (writes/posts for real)."
		ntn workers exec "$tool" -d "{\"dryRun\": false$extra}"
		;;
	*)
		echo "Dry $label run against the deployed worker — writes nothing."
		ntn workers exec "$tool" -d "{\"dryRun\": true$extra}"
		;;
esac
