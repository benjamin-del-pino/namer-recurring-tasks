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

The workflow handler receives a Notion SDK client as `context.notion`. It needs `NOTION_API_TOKEN` before the first API request.

For local development, put the token in `.env`. For a deployed worker, push the environment after deployment:

```shell
ntn workers deploy
ntn workers env push
```

Never commit `.env` or hard-code credentials. If the token is missing, ask the user to create one at https://app.notion.com/developers/tokens, grant it access to the relevant content, and add it to `.env` themselves.

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
- `logOverdueTasks` (`src/workflows/logOverdueTasks.ts`) runs on `triggers.scheduled()` (recurrence), scans the recurring-tasks database for overdue tasks, appends one row per task to the overdue log, and posts a Slack message per `Channel ID` grouping the tasks newly logged that run. Safe to re-run: rows already logged for the run date are skipped, and since Slack notification only covers newly-logged tasks, a re-run doesn't re-notify Slack either.
- `sendTaskReminders` (`src/workflows/sendTaskReminders.ts`, logic in `src/runReminders.ts`, on-demand tool `runSendReminders`) is the 15:00 ART reminder: per `Channel ID`, every task due today, then the 3 oldest overdue tasks and "There are X other overdue tasks, check Notion" (linking `SOURCE_DATABASE_URL`). Both queries exclude Status = `Complete`. Read-only, no dedupe: a manual `./test.sh reminders --write` re-posts. Its schedule (daily 15:00 America/Argentina/Buenos_Aires) must be set in the Workers UI after deploy.
- `src/slackNotify.ts` groups overdue tasks by their source `Channel ID` property, builds the message, and posts it via Slack's `chat.postMessage`. Tasks with no `Channel ID` are skipped with a `console.warn`, not a run failure.
- The message is Block Kit: one section per task (`block_id: task_<pageId>`) with a **Complete** button (`action_id: COMPLETE_ACTION_ID` = `complete_task_recurring_worker`, `value` = Notion page ID), capped at 45 task blocks plus an overflow line. It mirrors the n8n flow `pjGoufIAZrpougvp`. Do not rename the action_id: the planned click-listener worker routes on it.
- The Slack app ("Recurring Tasks Notifier") is shared with n8n, and its single Interactivity URL currently points at the n8n handler `KrS619xP0JKX3K7F`. That handler only acts on `complete_task` / `complete_task_recurring`, so clicks on this worker's buttons are ignored for now. Routing them to a listener worker still needs a decision: either n8n forwards this action_id, or the worker takes over the URL and handles all three.
- `NOTION_API_TOKEN` is set in the local `.env` (added 2026-08-27). It still needs `ntn workers env push` after the first deploy so the deployed worker has it too.
- `SLACK_API_KEY` (a Slack bot token with `chat:write`) is needed in `.env` for local runs and must be pushed with `ntn workers env push` after deploy, same as `NOTION_API_TOKEN`. Missing it throws a `TerminalError` from `postToChannel` so the run fails clearly instead of being retried automatically.
- `src/overdueLog.ts` currently points at the **sandbox test replica** data sources (`SOURCE_DATA_SOURCE_ID`, `LOG_DATA_SOURCE_ID`, `SOURCE_DATABASE_URL`). Swap to the production values noted in that file's comments before going live.
- Deployment (`ntn workers deploy`, `ntn workers env push`) is handled by the user directly — do not run it from here unless explicitly asked.
- Known CLI limitations (ntn 0.23.13): `ntn workers exec --local` still needs a classic `src/index.ts`, and `ntn workers exec logOverdueTasks` fails with "does not declare workflow.manual". No SDK version up to 0.9.2 offers a manual workflow trigger. For on-demand runs use `./test.sh` (dry run) or `./test.sh --write`, which exec the `runLogOverdueTasks` tool. Verified 2026-09-30: a real run posted a Complete-button message to #tests.
- As of 2026-09-30 there are no scheduled runs in the history since 2026-08-28, so the workflow's schedule doesn't appear to be set in the Notion Workers UI.
- **Test week (2026-09-30 to 2026-10-02).** Slack posts go through the **Recurring Tasks Tester** app (its bot token is `SLACK_API_KEY` here and in `../recurring-tasks-slack-actions`), and clicks are handled by that worker. There are three daily sandbox tasks owned by Ben (Budget Pacing, Platform Alerts Check, Creative Review), plus older test rows. Schedule set by Ben on 2026-09-30: daily 08:00 America/Argentina/Buenos_Aires. The sandbox database now has an automation that resets every task's Status to Not Started at 09:00 daily. On 2026-09-30 Ben also changed the date automation: completing a Daily task now moves its Due Date 1 day forward (replacing the +7 seen earlier that day). Whether that's +1 from the old due date or from the completion date decides whether a completed task is posted again the next morning. Check after the first completion.
