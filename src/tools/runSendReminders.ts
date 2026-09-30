import { j } from "@notionhq/workers/alpha/schema-builder";
import { createTool } from "@notionhq/workers/alpha/tool";
import { DEFAULT_TIMEZONE } from "../overdueLog.js";
import { runReminders } from "../runReminders.js";

/**
 * On-demand run of the same logic as the `sendTaskReminders` workflow, since
 * `ntn workers exec` can't start a schedule-only workflow:
 *
 *   ntn workers exec runSendReminders -d '{"dryRun": true}'
 *
 * Not deduped: every real run posts to Slack again.
 */
export default createTool({
	title: "Send task reminders now",
	description:
		"Posts the afternoon Slack reminder (tasks due today plus the oldest overdue ones) immediately, as the daily workflow would. Use dryRun first; a real run posts to Slack.",
	schema: j.object({
		dryRun: j.boolean().describe("When true, report what would be posted without posting to Slack."),
	}),
	execute: async ({ dryRun }, context) =>
		runReminders({
			notion: context.notion,
			timeZone: DEFAULT_TIMEZONE,
			dryRun,
			step: (_name, fn) => fn(),
		}),
});
