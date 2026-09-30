import { triggers } from "@notionhq/workers/alpha/triggers";
import { createWorkflow } from "@notionhq/workers/alpha/workflow";
import { DEFAULT_TIMEZONE } from "../overdueLog.js";
import { runReminders } from "../runReminders.js";

// Fires on a recurring schedule set in the Notion UI
// (app.notion.com/developers/workers) after deploying; the trigger takes no
// configuration in code. Set it to daily at 15:00
// America/Argentina/Buenos_Aires.
//
// `ntn workers exec` refuses scheduled workflows; use the `runSendReminders`
// tool for on-demand runs.
export default createWorkflow({
	name: "Send Afternoon Task Reminders",
	description:
		"Posts a Slack reminder per channel listing NAMER | Active Recurring Tasks due today, plus the three oldest overdue tasks and a count of the rest.",
	triggers: [triggers.scheduled()],
	handler: async (event, context) => {
		await runReminders({
			notion: context.notion,
			timeZone: event.timezone || DEFAULT_TIMEZONE,
			dryRun: Boolean(process.env.DRY_RUN),
			// context.step maps a void result to null; callers ignore void results.
			step: (name, fn) => context.step(name, fn) as Promise<never>,
		});
	},
});
