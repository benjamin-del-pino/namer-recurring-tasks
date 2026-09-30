import { triggers } from "@notionhq/workers/alpha/triggers";
import { createWorkflow } from "@notionhq/workers/alpha/workflow";
import { DEFAULT_TIMEZONE } from "../overdueLog.js";
import { runOverdueLog } from "../runOverdueLog.js";

// Fires on a recurring schedule. Frequency, time of day and timezone are set
// per-workflow in the Notion UI (app.notion.com/developers/workers) after
// deploying — the trigger takes no configuration in code. Set it to daily at
// 06:00 America/Argentina/Buenos_Aires.
//
// The platform only runs scheduled workflows on schedule; `ntn workers exec`
// refuses them ("does not declare workflow.manual"). Use the
// `runLogOverdueTasks` tool for on-demand runs.
export default createWorkflow({
	name: "Log Overdue Recurring Tasks",
	description:
		"Scans NAMER | Active Recurring Tasks and appends a row to Namer Paid Search Overdue Log for every task whose Due Date is in the past.",
	triggers: [triggers.scheduled()],
	handler: async (event, context) => {
		await runOverdueLog({
			notion: context.notion,
			timeZone: event.timezone || DEFAULT_TIMEZONE,
			dryRun: Boolean(process.env.DRY_RUN),
			// context.step maps a void result to null; callers ignore void results.
			step: (name, fn) => context.step(name, fn) as Promise<never>,
		});
	},
});
