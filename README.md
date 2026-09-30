# namer-recurring-tasks

A Notion Worker with one workflow, **`logOverdueTasks`**, plus an on-demand
tool that runs the same logic (see Testing). The workflow runs on a daily
schedule, scans `🔁 NAMER | Active Recurring Tasks` for tasks whose Due Date
has passed, appends one row per overdue task to
`⚠️ Namer Paid Search Overdue Log`, and posts a Slack message per channel
listing that channel's newly-overdue tasks.

This is the alpha file-based port of the classic-API `namer-recurring-tasks`
project.

## How it works

1. Resolves "today" in the workflow's recurrence timezone
   (`America/Argentina/Buenos_Aires` by default).
2. Queries the source database for tasks with `Due Date` before today.
3. Queries the log database for rows already logged today, so a re-run only
   fills in gaps instead of duplicating entries.
4. For each overdue task not already logged today, creates a log row with
   the task name, client, cadence, owner(s), and a notes field summarizing
   how overdue it is.
5. Groups the tasks that were newly logged this run by their source
   `Channel ID` property and posts one Slack message per channel, listing
   that channel's tasks with links back to their Notion pages. Each task
   row has a **Complete** button (see below). Because this only covers
   newly-logged tasks, a same-day re-run doesn't re-notify Slack — it
   reuses the log's own dedupe instead of tracking separate state.

### Complete button contract

Each task is its own Block Kit section, mirroring the n8n flow
`pjGoufIAZrpougvp`:

- `block_id`: `task_<Notion page ID>`
- button `action_id`: `complete_task_recurring_worker` (`COMPLETE_ACTION_ID`
  in `src/slackNotify.ts`); don't rename it, the click listener routes on it
- button `value`: the Notion page ID

A message holds at most 45 task rows. Any extra tasks are summarised in a
context line.

The Slack app is shared with n8n, whose handler `KrS619xP0JKX3K7F` owns the
app's single Interactivity URL. It ignores this action_id, so clicks
currently do nothing. A separate listener worker will handle them.

Deduplication key is task title + client (`src/overdueLog.ts`'s
`dedupeKey`), since the log has no back-relation to the source task.

## Project layout

- `src/workflows/logOverdueTasks.ts` — the workflow: trigger, orchestration,
  logging, Slack notification.
- `src/overdueLog.ts` — Notion query/paging, retry-with-backoff, page-to-task
  mapping, and log-row property building.
- `src/slackNotify.ts` — groups overdue tasks by `Channel ID`, builds the
  Slack message, and posts it via `chat.postMessage`.
- `src/runOverdueLog.ts` — the shared run logic, used by the workflow and
  the tool.
- `src/tools/runLogOverdueTasks.ts` — on-demand tool (`{"dryRun": boolean}`).
- `test.sh` — runs the tool against the deployed worker.

## Configuration

`src/overdueLog.ts` currently points at **sandbox test replica** data
sources:

- `SOURCE_DATA_SOURCE_ID` → `🔁 Workers Test - NAMER | Active Recurring Tasks`
- `LOG_DATA_SOURCE_ID` → `⚠️ Workers Test - Namer Paid Search Overdue Log`

Swap both for the production IDs noted in that file's comments before going
live:

- Source → `🔁 NAMER | Active Recurring Tasks` (`26e05ce3-3757-83ef-9481-8751c9ba8766`)
- Log → `⚠️ Namer Paid Search Overdue Log` (`e6805ce3-3757-82b5-b766-8713fcb4c60d`)

`NOTION_API_TOKEN` must be set in `.env` for local runs, and pushed to the
deployed worker separately (see below).

Slack notifications need `SLACK_API_KEY` (a Slack bot token with the
`chat:write` scope — add `chat:write.public` too if the bot should post to
public channels it hasn't been invited to) set the same way — in `.env`
for local runs, then pushed to the deployed worker with
`ntn workers env push`. Tasks without a `Channel ID` are skipped (with a
warning in the run logs) rather than failing the run.

## Commands

```shell
npm run check    # type-check
npm run build    # discover workflows and build the worker
ntn login         # connect to a Notion workspace
ntn workers deploy    # build and deploy
ntn workers env push  # push .env values to the deployed worker
```

## Testing

```shell
./test.sh          # dry run against the deployed worker — writes nothing
./test.sh --write  # real run — creates log rows and posts to Slack
```

Both modes run the `runLogOverdueTasks` tool (`src/tools/`). It shares
`src/runOverdueLog.ts` with the workflow and returns a summary
(`overdue`, `created`, `skipped`, `notifiedChannels`). A tool is needed
because `ntn workers exec` (ntn 0.23.13) refuses schedule-only workflows
("does not declare workflow.manual"), and `exec --local` still needs a
classic `src/index.ts`.

Verified 2026-09-30: `./test.sh --write` logged the sandbox's overdue task
and posted a message to #tests with a Complete button and a working link
back to the Notion task.

## Debugging

```shell
ntn workers runs list
ntn workers runs logs <run-id>
```
