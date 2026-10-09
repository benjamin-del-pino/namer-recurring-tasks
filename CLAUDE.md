# Repository Guidelines

Overall Workers documentation lives at https://developers.notion.com/workers/get-started/overview.md.

## Project Structure

- `src/workflows/` contains workflow definitions. Each file directly inside this directory defines one workflow.
- The basename of a workflow file becomes its key. Use camelCase, such as `onPageCreated.ts`.
- Generated files live in `dist/` and `.notion/`; do not edit them by hand.

## Workflow API

Create workflows with `createWorkflow` and declare their triggers with `triggers`:

```ts
// src/workflows/onPageCreated.ts
import { triggers } from "@notionhq/workers/alpha/triggers";
import { createWorkflow } from "@notionhq/workers/alpha/workflow";

export default createWorkflow({
  title: "Process new pages",
  description: "Processes a page after it is added to a database.",
  triggers: [triggers.notionPageCreated()],
  handler: async (event, context) => {
    await context.step("Process page", async ({ id }) => {
      console.log(`Processing ${event.url} with idempotency key ${id}`);
      return { pageUrl: event.url };
    });
  },
});
```

- Default-export the result of `createWorkflow(...)` from a file directly under `src/workflows/`.
- Provide a specific, human-readable `title` and `description`.
- `triggers` must be a non-empty array of trigger creators from `@notionhq/workers/alpha/triggers`.
- Let TypeScript infer the handler event from the trigger array. When a workflow has multiple triggers, narrow the event with `event.type` before reading trigger-specific fields.
- Read the installed SDK declarations when choosing a trigger or accessing its event fields. Do not guess field names from provider payloads.

## Durable Steps

Use `context.step(name, callback)` as the workflow's determinism boundary. **Anything non-deterministic must happen inside a step**, whether the non-determinism is in the operation's result or its external effect. Only deterministic computation belongs outside steps.

- Always `await` a step.
- Put any I/O whose result affects later behavior or output inside a step, including network, Notion API, database, and filesystem reads.
- Put time generation inside a step when the value matters, including `Date.now()` and `new Date()`.
- Put random value and identifier generation inside a step, including `Math.random()`, `crypto.getRandomValues()`, and `crypto.randomUUID()`.
- Put anything intended to happen once inside a step, even when its return value is unused. Such work is non-deterministic because its external effect differs depending on whether it runs. This includes sending messages, notifications, or email; creating or updating records; and calling action-style APIs.
- Design one-time work to be idempotent because an attempt can fail after the external action succeeds but before its step result is recorded.
- Deterministic transformations of values already returned by steps can remain outside steps.
- Keep step order deterministic. Saved results are associated with call order, so inserting, removing, or conditionally skipping an earlier step can change which saved result a later step receives.
- Return JSON-serializable values. A callback that returns `undefined` is recorded and replayed as `null`.
- Give every step a unique, concise, action-oriented name. When the same operation runs more than once, include a stable entity ID or a deterministic index, such as `"Update page 4 (page-id)"`; never emit duplicate names within one run.
- Keep generated names deterministic across retries. When iterating a collection returned by an earlier step, use its recorded order directly and include the item index, a stable ID, or both.
- The callback receives `{ id }`. Use this identifier as an idempotency key when the downstream service supports one.
- A successful step may be replayed without running its callback again. Never rely on in-memory mutations performed inside one step being present after replay; return the data needed by later code.
- Let step failures propagate unless the workflow has an explicit recovery path. Catching an error and reporting success prevents the run from showing the failure.

Prefer small steps around each non-deterministic result or side-effect boundary:

```ts
const page = await context.step("Fetch page", () =>
  context.notion.pages.retrieve({ page_id: pageId }),
);

const runMetadata = await context.step("Generate run metadata", () => ({
  startedAt: new Date().toISOString(),
  nonce: crypto.randomUUID(),
}));

await context.step("Notify downstream service", async ({ id }) => {
  const response = await fetch(process.env.SERVICE_URL ?? "", {
    method: "POST",
    headers: { "Idempotency-Key": id, "Content-Type": "application/json" },
    body: JSON.stringify({ page, runMetadata }),
  });

  if (!response.ok) {
    throw new Error(`Downstream request failed: ${response.status}`);
  }
});
```

For repeated work, make each name distinct while preserving deterministic call order:

```ts
const pages = await context.step("Fetch pages", () => fetchPages());

for (const [index, page] of pages.entries()) {
  await context.step(`Update page ${index + 1} (${page.id})`, () => updatePage(page));
}
```

## Notion API Access

The workflow handler receives a Notion SDK client as `context.notion`. It is authenticated by the platform, so no Notion token is needed in `.env` or the deployed environment.

Never commit `.env` or hard-code credentials.

## Build and Development Commands

- Node >= 22 and npm >= 10.9.2 are required.
- `npm run build`: discover workflow files and build the worker.
- `npm run check`: type-check without emitting files.
- `ntn login`: connect to a Notion workspace.
- `ntn workers deploy`: build and deploy workflows.
- `ntn workers env push`: push values from `.env` to the deployed worker.

After changing a workflow, run:

```shell
npm run check
npm run build
```

## Debugging Runs

Use run history and logs to diagnose deployed workflow failures:

```shell
ntn workers runs list
ntn workers runs logs <run-id>
```

Start with the first error and the last completed step. Check whether a failed side effect supports the step id as an idempotency key before retrying it manually.

## Coding Style

- TypeScript runs with `strict` enabled. Keep event narrowing and external response types explicit.
- Use tabs for indentation and camelCase for workflow filenames and keys.
- Validate HTTP responses before consuming or returning them.
- Read secrets through `process.env` and fail with a clear message when required configuration is absent.
- Keep workflow handlers orchestration-focused; extract substantial parsing and transformation logic into nearby modules.

## Testing Guidelines

- There is no test runner configured by default. At minimum, run `npm run check` and `npm run build`.
- Test handler logic with representative event objects and stub external requests.
- Test success, malformed input, missing configuration, non-success HTTP responses, and retry-safe behavior.
- Keep step order stable in tests and production code. When step order intentionally changes, treat existing saved runs as a compatibility concern.

## Commit and Pull Request Guidelines

- Commit messages typically use `feat(scope): ...`, `TASK-123: ...`, or a concise imperative summary.
- Pull requests should describe the workflow behavior, list commands run, identify triggers, and call out side effects or idempotency assumptions.

## Project Notes

This worker ports the classic-API `namer-recurring-tasks` project to the alpha file-based workflow API.

- The logic lives in `src/runOverdueLog.ts`, which is shared by two capabilities: the `logOverdueTasks` workflow (scheduled, durable steps) and the `runLogOverdueTasks` tool (`src/tools/`, on demand, `{"dryRun": boolean}`, no steps). The tool exists because `ntn workers exec` refuses schedule-only workflows. Keep the step names and order in `runOverdueLog` stable.
- `logOverdueTasks` (`src/workflows/logOverdueTasks.ts`) runs on `triggers.scheduled()` (recurrence), scans the recurring-tasks database for overdue tasks and appends one row per task to the overdue log (rows already logged for the run date are skipped, so the log is safe to re-run). Since 2026-10-09 its Slack message is the **same as the afternoon reminder**: it calls `runReminders` (step names prefixed `Morning: ` because both runs have a "Fetch overdue tasks" step), so it shows every open task due today, then **every** open overdue task (oldest first, `maxOverdue: Infinity`), per `Channel ID`. Slack caps a message at 50 blocks, so `buildReminderMessage` limits the overdue list to the room left after the due-today section (about 46 rows at most, fewer when many tasks are due today) and counts the rest in an "X other overdue tasks, check Notion" line. The afternoon reminder keeps its cap of 3 (`MAX_REMINDER_OVERDUE`). The message is no longer limited to the newly-logged tasks and is not deduped: a manual `./test.sh --write` re-posts. `buildMessage` in `slackNotify.ts` (the old flat overdue list) is now unused.
- `sendTaskReminders` (`src/workflows/sendTaskReminders.ts`, logic in `src/runReminders.ts`, on-demand tool `runSendReminders`) is the 15:00 ART reminder: per `Channel ID`, every task due today, then the 3 oldest overdue tasks and "There are X other overdue tasks, check Notion" (linking `SOURCE_DATABASE_URL`). Both queries exclude Status = `Complete`. Read-only, no dedupe: a manual `./test.sh reminders --write` re-posts. Deployed 2026-09-30; Ben set its schedule to daily 15:00 America/Argentina/Buenos_Aires the same day. First scheduled run is 2026-09-30 15:00.
- `src/slackNotify.ts` groups overdue tasks by their source `Channel ID` property, builds the message, and posts it via Slack's `chat.postMessage`. Tasks with no `Channel ID` are skipped with a `console.warn`, not a run failure.
- The message is Block Kit: one section per task (`block_id: task_<pageId>`) with a **Complete** button (`action_id: COMPLETE_ACTION_ID` = `complete_task_recurring_worker`, `value` = Notion page ID), capped at 45 task blocks plus an overflow line. It mirrors the n8n flow `pjGoufIAZrpougvp`. Do not rename the action_id: the planned click-listener worker routes on it.
- The Slack app ("Recurring Tasks Notifier") is shared with n8n, and its single Interactivity URL currently points at the n8n handler `KrS619xP0JKX3K7F`. That handler only acts on `complete_task` / `complete_task_recurring`, so clicks on this worker's buttons are ignored for now. Routing them to a listener worker still needs a decision: either n8n forwards this action_id, or the worker takes over the URL and handles all three.
- `SLACK_API_KEY` (a Slack bot token with `chat:write`) is needed in `.env` for local runs and must be pushed with `ntn workers env push` after deploy. Missing it throws a `TerminalError` from `postToChannel` so the run fails clearly instead of being retried automatically.
- `src/overdueLog.ts` currently points at the **sandbox test replica** data sources (`SOURCE_DATA_SOURCE_ID`, `LOG_DATA_SOURCE_ID`, `SOURCE_DATABASE_URL`). Swap to the production values noted in that file's comments before going live.
- Deployment (`ntn workers deploy`, `ntn workers env push`) is handled by the user directly — do not run it from here unless explicitly asked.
- Known CLI limitations (ntn 0.23.13): `ntn workers exec --local` still needs a classic `src/index.ts`, and `ntn workers exec logOverdueTasks` fails with "does not declare workflow.manual". No SDK version up to 0.9.2 offers a manual workflow trigger. For on-demand runs use `./test.sh` (dry run) or `./test.sh --write`, which exec the `runLogOverdueTasks` tool. Verified 2026-09-30: a real run posted a Complete-button message to #tests.
- As of 2026-09-30 there are no scheduled runs in the history since 2026-08-28, so the workflow's schedule doesn't appear to be set in the Notion Workers UI.
- **Test week (2026-09-30 to 2026-10-02).** Slack posts go through the **Recurring Tasks Tester** app (its bot token is `SLACK_API_KEY` here and in `../recurring-tasks-slack-actions`), and clicks are handled by that worker. The button looks clickable again for about 3s after a click, and that can't be fixed on the worker side. On 2026-10-01 a double click completed one sandbox page twice. That worker now skips clicks on rows already completed. The Tester app got the `channels:history`/`groups:history` scopes it needs the same day. There are three daily sandbox tasks owned by Ben (Budget Pacing, Platform Alerts Check, Creative Review), plus older test rows. Schedule set by Ben on 2026-09-30: daily 08:00 America/Argentina/Buenos_Aires. The sandbox database now has an automation that resets every task's Status to Not Started at 09:00 daily. On 2026-09-30 Ben also changed the date automation: completing a Daily task now moves its Due Date 1 day forward (replacing the +7 seen earlier that day). Whether that's +1 from the old due date or from the completion date decides whether a completed task is posted again the next morning. Check after the first completion.

## In progress: instant "Completed" in Slack (started 2026-10-05)

**Status (2026-10-09): deployed and working in the sandbox (#tests, Workers Test databases).** Ben confirmed a click now flips the row to "Completed by" at once. Pieces: `../recurring-tasks-slack-app` (hosted app `A0C82J3A76W`, README has setup), `../recurring-tasks-slack-actions/src/relay.ts` (relayed-click path), and `postViaHostedApp` in `src/slackNotify.ts` (used when `SLACK_POST_WEBHOOK_URL` is set, else the old `chat.postMessage` path with `SLACK_API_KEY`; each post logs which path it took). Env: `RELAY_SECRET` (same value in both workers and the Slack app), `SLACK_POST_WEBHOOK_URL` here, `FAILURE_WEBHOOK_URL` in the click worker.

Lessons from the first deploy: (1) `ntn workers deploy` ships what git has staged, so `git add` modified and new files before deploying, or the old code runs (the first test post went out through the old Tester path). (2) The hosted app has two webhook triggers, Post and Restore, and their URLs look identical; `SLACK_POST_WEBHOOK_URL` was first set to the Restore URL, so every post silently started the wrong workflow. A Slack webhook answers 200 before the app runs, so the worker cannot see this: check `slack activity --app A0C82J3A76W --level trace` (it shows "Post task message" started). `Ft0C84M9898R` is a duplicate Post trigger and can be deleted.

Verified 2026-10-09 in #tests: (1) 45-task message (47 blocks, ~25 KB) posts in full through the post webhook. (2) Failure path: a click on a row whose Notion write fails shows "Completed by" at once, then the row becomes the task link plus ":warning: Couldn't mark this complete in Notion. Please update it in Notion." with **no button** (Ben's choice: fix it in Notion, don't retry). If the message can't be read back, a warning is posted in the message's thread instead. (3) Double click: a fast double click produced one relay run and one Notion write (Status Complete, Due Date 2026-10-10). The second click probably hit the already-edited row (no button), so the `duplicate` branch was not exercised in a real race. (4) Latency: 94-133ms from click to handler when warm, ~1.8s on the first click after idle.

Bugs found by those tests, now fixed: the app was not a member of #tests, so `conversations.history` failed with `not_in_channel` and the double-click guard had been silently inert on every click. `lib/messages.ts` `readMessage` now joins public channels (scope `channels:join`) and retries; a private channel still needs a manual `/invite` of the app, otherwise the guard stays inert there and a failed restore falls back to the thread warning.

Still unverified: message clickability after 7 days (3 days worked); whether redeploying the hosted app closes the runs behind live messages (assume it does: post fresh messages after a redeploy, and avoid redeploying with real messages open); the `duplicate` branch under a true simultaneous double click. Production cutover not started: swap the sandbox IDs in `src/overdueLog.ts`, invite the hosted app to each real channel (private ones need it for the guard), keep the old Notifier/Tester apps for n8n, and retire nothing until a week of real clicks.

- **Cause of the ~3s:** it is spent before `handleClick` runs. `sinceClickMs` is 2.8-3.1s on every logged click in `../recurring-tasks-slack-actions`, including back-to-back bursts, so it is not a cold start and keep-warm won't help. The worker already edits Slack in parallel with the Notion write and reverts on failure, so reordering code in the worker cannot remove the gap. The Slack edit itself takes 60-250ms.
- **Route under test:** a Slack-hosted app (Deno, next-gen platform) as the click handler. Probe project: `~/Desktop/workers/click-latency-probe` (app `A0C7PQXKX6C`, workspace brainlabsdigital, Slack CLI v4.9.0, Deno installed via brew).
- **Proven (2026-10-05):** a hosted handler starts 62-117ms after the click and edits the message instantly. This also holds for a message posted by the app from a webhook trigger (90ms).
- **Ruled out:** posting from this worker with a bot token. CLI-created apps expose no bot token, so the worker cannot post as the hosted app. Design is: the worker calls the app's **webhook trigger** (once per channel, passing channel + blocks JSON), and the hosted app posts the message. Clicks only route to the handler for messages posted by a function run.
- **Open risk (decides the route):** how long a message stays clickable. The handler depends on the posting function run staying open, and its limit is unknown. Overdue and reminder messages sit for days. Three age-probe messages were posted from the probe webhook on 2026-10-05, labelled by click age. Click one at ~24h, ~72h and ~7d, and note the result. Each message works for one click; do not click early, and do not redeploy the probe app.
- **Age test results:** 24h (2026-10-06): the click worked, but the handler started **1644ms** after the click, against 62-117ms on same-day clicks. Cause unknown (cold handler after a day idle, a slowdown that grows with message age, or a one-off). A second message of the same age, clicked minutes later (2026-10-06 ~14:50), started in **106ms**, so age alone does not slow it; an idle cold start is the likely cause but one pair of samples does not prove it. NOTE: that second click was on the message labelled "72h" but only ~24h old, so it was NOT the 72h test; the 72h and 7d messages are now spent or must be re-posted if clicked early. Likely mitigation if cold starts matter: a scheduled keep-warm ping (untested). Still to do: click an old message twice in a row, click a message posted a few hours earlier, and record latency (not just success) for the 72h and 7d clicks. If latency grows with age, reconsider: a 1.6s+ gap is only about half of today's 3s.
- **Age test conclusion (2026-10-08):** the last probe message, posted 2026-10-05 ~14:30 and labelled "7d", was clicked on 2026-10-08, so it was ~3 days old, not 7. It worked, with a handler start of **1503ms**. So: clickable at ~24h and ~3 days; 7 days untested (that message is spent). Latency pattern across all clicks: ~60-120ms when the handler was recently used, ~1.5-1.6s on the first click after a long idle (2 of 2 cold samples), which supports the idle cold-start theory. Cold is still about half of the worker's 3s. Untested mitigation: a scheduled keep-warm ping. Open question: do overdue tasks stay in a message longer than ~3 days? If so, post a fresh message each run (the overdue run already posts per day) or test 7d.
- **Decision (2026-10-05): the existing worker keeps doing the Notion write.** The hosted app never holds a Notion token. If the age tests pass, the build is:
  1. Hosted app: webhook trigger posts the message (channel + blocks JSON); click handler runs its own double-click guard, edits the message to "Completed by" at once, then fire-and-forgets the click to the `recurring-tasks-slack-actions` webhook.
  2. Click worker changes: accept a relayed click signed with a shared secret (HMAC, new env var on both sides) instead of Slack's signature; skip its own double-click guard and message edit when relayed (the row is already marked completed, so the current guard would wrongly return `duplicate`); keep the Notion write as is, with no auto-retry on a repeat (NAMER's recurrence skips an occurrence).
  3. Failure path: the worker cannot `chat.update` a message the hosted app posted (no token for that app), so on a failed write it calls a **second webhook trigger on the hosted app** that restores the original blocks plus a visible failure line.
  4. `slackNotify.ts` / `runReminders.ts` call the hosted app's post webhook instead of `chat.postMessage` (new env var for the URL, pushed by Ben). Test a realistic 45-task payload first.
  5. Retire nothing: the click worker stays, now behind the hosted app. Delete the probe app with `slack app delete` once the real app exists.
- **If they fail:** fall back to a thin relay (Vercel function: verify signature, `chat.update`, forward to the worker's webhook with a flag so the worker skips its guard and edit).
- **Open:** how the hosted app authenticates to the worker webhook (shared-secret HMAC is the plan) and how the worker authenticates its failure callback to the app.
- **Secrets:** both webhook URLs are secrets; keep them out of the repo.
