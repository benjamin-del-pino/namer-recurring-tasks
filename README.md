# namer-recurring-tasks

A Notion Worker with one workflow: **`logOverdueTasks`**. It runs on a daily
schedule, scans `🔁 NAMER | Active Recurring Tasks` for tasks whose Due Date
has passed, and appends one row per overdue task to
`⚠️ Namer Paid Search Overdue Log`.

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

Deduplication key is task title + client (`src/overdueLog.ts`'s
`dedupeKey`), since the log has no back-relation to the source task.

## Project layout

- `src/workflows/logOverdueTasks.ts` — the workflow: trigger, orchestration,
  logging.
- `src/overdueLog.ts` — Notion query/paging, retry-with-backoff, page-to-task
  mapping, and log-row property building.
- `test.sh` — drives the workflow with a synthetic recurrence event.

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
./test.sh           # dry run — reads Notion, writes nothing
./test.sh --write    # local run — creates log rows
./test.sh --remote   # run against the deployed worker
```

**Known limitation:** `ntn workers exec --local` (ntn 0.22.10) looks for a
classic `src/index.ts` entry point and doesn't discover alpha
`src/workflows/` files, so `--write` and the default dry-run mode currently
fail with "Could not find src/index.ts". Use `./test.sh --remote` against a
deployed worker instead (set `DRY_RUN=1` via `ntn workers env push` first for
a safe remote dry run).

## Debugging

```shell
ntn workers runs list
ntn workers runs logs <run-id>
```
