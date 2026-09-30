import { j } from "@notionhq/workers/alpha/schema-builder";
import { createTool } from "@notionhq/workers/alpha/tool";
import { DEFAULT_TIMEZONE } from "../overdueLog.js";
import { runOverdueLog } from "../runOverdueLog.js";

/**
 * On-demand run of the same logic as the `logOverdueTasks` workflow, since
 * `ntn workers exec` can't start a schedule-only workflow:
 *
 *   ntn workers exec runLogOverdueTasks -d '{"dryRun": true}'
 *
 * Not durable: there are no steps, so a failure midway just stops. Re-running
 * is safe because rows already logged today are skipped, and Slack only gets
 * the newly logged tasks.
 */
export default createTool({
	title: "Run overdue task log now",
	description:
		"Runs the overdue-task log and Slack notification immediately, as the daily workflow would. Use dryRun first; a real run writes log rows and posts to Slack.",
	schema: j.object({
		dryRun: j.boolean().describe("When true, report what would happen without writing to Notion or posting to Slack."),
	}),
	execute: async ({ dryRun }, context) =>
		runOverdueLog({
			notion: context.notion,
			timeZone: DEFAULT_TIMEZONE,
			dryRun,
			step: (_name, fn) => fn(),
		}),
});
