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
- `logOverdueTasks` (`src/workflows/logOverdueTasks.ts`) runs on `triggers.scheduled()` (recurrence), scans the recurring-tasks database for overdue tasks and appends one row per task to the overdue log (rows already logged for the run date are skipped, so the log is safe to re-run). Since 2026-10-09 its Slack posts are the **same as the afternoon reminder**: it calls `runReminders` (step names prefixed `Morning: ` because both runs have a "Fetch overdue tasks" step), so it posts every open task due today, then **every** open overdue task (oldest first, `maxOverdue: Infinity`, no cap since each task is its own message), per `Channel ID`. The afternoon reminder keeps its cap of 3 (`MAX_REMINDER_OVERDUE`). Posts are not limited to the newly-logged tasks and are not deduped: a manual `./test.sh --write` re-posts. `buildMessage` in `slackNotify.ts` (the old flat overdue list) is unused.
- `sendTaskReminders` (`src/workflows/sendTaskReminders.ts`, logic in `src/runReminders.ts`, on-demand tool `runSendReminders`) is the 15:00 ART reminder: per `Channel ID`, every task due today, then the 3 oldest overdue tasks and "There are X other overdue tasks, check Notion" (linking `SOURCE_DATABASE_URL`). Both queries exclude Status = `Complete`. Read-only, no dedupe: a manual `./test.sh reminders --write` re-posts. Deployed 2026-09-30; Ben set its schedule to daily 15:00 America/Argentina/Buenos_Aires the same day. First scheduled run is 2026-09-30 15:00.
- `src/slackNotify.ts` groups overdue tasks by their source `Channel ID` property, builds the message, and posts it through the Slack-hosted app's webhook when `SLACK_POST_WEBHOOK_URL` is set (the normal path, see "Instant Completed in Slack" below), else via Slack's `chat.postMessage` with `SLACK_API_KEY` (legacy fallback). Tasks with no `Channel ID` are skipped with a `console.warn`, not a run failure.
- **One Slack message per task** (since 2026-10-14, `buildChannelPosts`, mirroring `../ceo-office-recurring-tasks`; headings reworked 2026-10-14): three sections, each a heading message then one message per task: due today ("The following tasks are due today:"), due today and Run by Agent ("These tasks due today are for the Agent:"), and overdue ("These are overdue:"; overdue Agent tasks stay here). The first heading gets a "Hey there, " greeting and an empty section gets no heading. Agent tasks got their own section because their thread breaks Slack's message grouping (the app name shows again on the threaded message and the one after it); a thread can't be avoided because the agent will post its output there, and a delayed reply is not expected to help (untested). Each task message is just the task section (`block_id: task_<pageId>`) with a **Complete** button (`action_id: COMPLETE_ACTION_ID` = `complete_task_recurring_worker`, `value` = Notion page ID). When the afternoon cap leaves tasks out, one last message with no button says "There are X other overdue tasks, check Notion". Each message is its own step (`Notify due-today heading in <channel>`, `Notify task <n> in <channel> (<pageId>)`, `Notify agent heading in <channel>`, `Notify overdue heading in <channel>`, `Notify overflow in <channel>`), so a retry re-posts only the failed ones. Each message after a channel's first waits 2s (`POST_GAP_MS`): the hosted app's webhook answers before posting, and back-to-back calls landed out of order on 2026-10-14. Do not rename the action_id: the click worker and hosted app route on it.
- **Agent thread:** a task whose `Run by` select is `Agent` gets a reply in its thread, `[Agent] this is for you.` (`buildAgentThread`). `[Agent]` is a placeholder until the agent is chosen: set `AGENT_SLACK_USER_ID` (a Slack user ID) and push env to tag it as `<@ID>` instead. The worker can't thread itself (the hosted app's webhook never returns the message `ts`), so it sends the reply as `thread_json` and the hosted app posts it under the message; a failed reply shows only in `slack activity` as `[post] ... thread`. On the `SLACK_API_KEY` fallback the worker threads it itself and logs, not throws, a failed reply.
- The Slack app "Recurring Tasks Notifier" is shared with n8n and its single Interactivity URL points at the n8n handler `KrS619xP0JKX3K7F`; it ignores this worker's `complete_task_recurring_worker` buttons. That is why the sandbox posts through the hosted app (below) or the Tester app, not the Notifier. Production cutover must not move the Notifier's Interactivity URL without a decision about n8n's own buttons.
- Env: `SLACK_POST_WEBHOOK_URL` (the hosted app's **Post** trigger URL) and `RELAY_SECRET` (shared with the hosted app and the click worker) are the normal path; push with `ntn workers env push`. `AGENT_SLACK_USER_ID` (optional, empty for now) is the agent tagged in Agent threads. `SLACK_API_KEY` (bot token with `chat:write`) is only the fallback when `SLACK_POST_WEBHOOK_URL` is empty; with neither set, `postToChannel` throws a `TerminalError` so the run fails clearly instead of being retried. Do not put quotes around values in `.env`. A hosted-app post failure does not surface here (Slack's webhook answers before the app runs): check `slack activity --app A0C82J3A76W --level trace` in `../recurring-tasks-slack-app`.
- **Production cutover (2026-10-15, dry-run stage).** `src/overdueLog.ts` now points at the **production** data sources: `🔁 NAMER | Active Recurring Tasks` (`26e05ce3-3757-83ef-9481-8751c9ba8766`) and `⚠️ Namer Recurring Tasks Overdue Log` (`e6805ce3-3757-82b5-b766-8713fcb4c60d`). The sandbox IDs are in the comments for rollback. Deployed from branch `feat/production-cutover` with **`DRY_RUN=1` set on the deployed worker**, so both scheduled workflows read Notion but write no log rows and post nothing. Go live with `ntn workers env unset DRY_RUN`, not `=0`: any non-empty string is truthy. **No Cadence rule (2026-10-15):** tasks whose Cadence is explicitly `No Cadence` are neither logged nor posted (`isNoCadence` in `overdueLog.ts`, applied in `runOverdueLog` and `runReminders`'s `toTasks`). This matches n8n. Blank Cadence and Annual stay in (n8n logged blanks). Weekday-only schedules and one message per task are intended. Tool dry runs on 2026-10-15, after the rule, posted nothing. Morning: 161 overdue (10 No Cadence ignored), all 161 already logged by n8n, 0 would be created, 202 task messages across 42 channels, 10 overdue tasks with no Channel ID. Afternoon: 56 due today, 156 overdue, 120 task messages plus 17 overflow lines. Before go-live:
  - Confirm a scheduled `workflow:` run on the production DBs ended with status 0 (proves each workflow's integration has access).
  - Deactivate the n8n `recurring-tasks-project` (`pjGoufIAZrpougvp`, 06:00 ART Tue-Sat, logs and posts) and `recurring-tasks-due-today` (`4W8EABUdzvrJ97gZ`, 15:00 Mon-Fri), or logs and posts double up.
  - Connect the click worker to the production source DB and invite the hosted app to private channels.
- Deployment (`ntn workers deploy`, `ntn workers env push`) is handled by the user directly — do not run it from here unless explicitly asked.
- Known CLI limitations (ntn 0.23.13): `ntn workers exec --local` still needs a classic `src/index.ts`, and `ntn workers exec logOverdueTasks` fails with "does not declare workflow.manual". No SDK version up to 0.9.2 offers a manual workflow trigger. For on-demand runs use `./test.sh` (dry run) or `./test.sh --write`, which exec the `runLogOverdueTasks` tool. Verified 2026-09-30: a real run posted a Complete-button message to #tests.
- As of 2026-09-30 there are no scheduled runs in the history since 2026-08-28, so the workflow's schedule doesn't appear to be set in the Notion Workers UI.
- **Test week (2026-09-30 to 2026-10-02).** Slack posts go through the **Recurring Tasks Tester** app (its bot token is `SLACK_API_KEY` here and in `../recurring-tasks-slack-actions`), and clicks are handled by that worker. The button looks clickable again for about 3s after a click, and that can't be fixed on the worker side. On 2026-10-01 a double click completed one sandbox page twice. That worker now skips clicks on rows already completed. The Tester app got the `channels:history`/`groups:history` scopes it needs the same day. There are three daily sandbox tasks owned by Ben (Budget Pacing, Platform Alerts Check, Creative Review), plus older test rows. Schedule set by Ben on 2026-09-30: daily 08:00 America/Argentina/Buenos_Aires. The sandbox database now has an automation that resets every task's Status to Not Started at 09:00 daily. On 2026-09-30 Ben also changed the date automation: completing a Daily task now moves its Due Date 1 day forward (replacing the +7 seen earlier that day). Whether that's +1 from the old due date or from the completion date decides whether a completed task is posted again the next morning. Check after the first completion.

## Instant "Completed" in Slack (hosted Slack app, built 2026-10-05..09)

**Status: deployed and verified in the sandbox (#tests, Workers Test databases). Production cutover not started.**

**Why:** a click on Complete used to take ~3s to change the message, and the button looked clickable again meanwhile. The 3s is Notion's webhook dispatch, before any worker code runs (`sinceClickMs` 2.8-3.1s on every click, so not a cold start), so no change inside the click worker could remove it.

**Architecture (three projects):**
- `namer-recurring-tasks` (this worker) finds the tasks, logs the overdues and builds the message; it POSTs channel + blocks to the hosted app's Post webhook.
- `../recurring-tasks-slack-app` (Slack-hosted Deno app `A0C82J3A76W`, README has setup and deploy steps) posts the message and owns its buttons: on a click it checks for a double click, edits the row to "Completed by @user" (~100ms), then forwards the click, signed with `RELAY_SECRET`, to the click worker. CLI-created apps expose no bot token, so this worker cannot post as the app or edit its messages.
- `../recurring-tasks-slack-actions` (click worker) is the only thing that writes to Notion (Status = Complete; NAMER's recurrence automation does the rest). A failed write calls the app's Restore webhook (`FAILURE_WEBHOOK_URL`), which replaces the row with the task link plus ":warning: Couldn't mark this complete in Notion. Please update it in Notion." and **no button**; if the message can't be read, it warns in the message's thread.
- One secret (`RELAY_SECRET`) protects all three hops; both webhook URLs are secrets too. The Post and Restore URLs look alike: `SLACK_POST_WEBHOOK_URL` was once set to the Restore URL and every post silently failed. A Slack webhook answers 200 before the app runs, so confirm with `slack activity`.

**Measured:** click to handler 94-133ms warm, ~1.5-1.8s on the first click after a long idle (cold start; untested mitigation: keep-warm ping). Buttons still worked ~24h and ~3 days after posting (the posting function run stays open on purpose; Slack only routes clicks to the run that posted the message). A 47-block, ~25 KB message posts in full. A fast double click gave one relay run and one Notion write; the `duplicate` branch has not been seen in a real race.

**Lessons:** (1) `ntn workers deploy` ships what git has staged: `git add` changed and new files first, or the old code runs. (2) The app is not a member of channels it posts to (`chat:write.public`), so `conversations.history` failed with `not_in_channel` and the double-click guard was silently inert until `lib/messages.ts` `readMessage` started joining public channels (scope `channels:join`). Private channels need a manual `/invite`. (3) Redeploying the hosted app probably ends the function runs behind live messages: post fresh messages after any redeploy.

**Still open:** buttons after 7 days (3 days worked); production cutover (swap the sandbox IDs in `src/overdueLog.ts`, invite the app to every real channel including private ones, keep the Notifier/Tester apps for n8n, keep the click worker's old Slack-signed path until a week of real clicks); fallback if the hosted route ever fails: a thin relay (e.g. a Vercel function) in front of the click worker.
