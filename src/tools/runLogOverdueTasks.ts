import { j } from "@notionhq/workers/alpha/schema-builder";
import { createTool } from "@notionhq/workers/alpha/tool";
import { DEFAULT_TIMEZONE } from "../overdueLog.js";
import { runOverdueLog } from "../runOverdueLog.js";

/**
 * On-demand run of the same logic as the `logOverdueTasks` workflow, since
 * `ntn workers exec` can't start a schedule-only workflow:
 *
 *   ntn workers exec runLogOverdueTasks -d '{"dryRun": true, "channels": null}'
 *
 * Not durable: there are no steps, so a failure midway just stops. Re-running
 * is safe for the log (rows already logged today are skipped), but the Slack
 * posts are not deduped: pass `channels` to post only to the channels a failed
 * run missed.
 */
export default createTool({
	title: "Run overdue task log now",
	description:
		"Runs the overdue-task log and Slack notification immediately, as the daily workflow would. Use dryRun first; a real run writes log rows and posts to Slack.",
	schema: j.object({
		dryRun: j.boolean().describe("When true, report what would happen without writing to Notion or posting to Slack."),
		channels: j
			.array(j.string())
			.nullable()
			.describe("Only post to these Slack channel IDs; null posts to every channel. The log is written in full either way."),
	}),
	execute: async ({ dryRun, channels }, context) =>
		runOverdueLog({
			notion: context.notion,
			timeZone: DEFAULT_TIMEZONE,
			dryRun,
			channels,
			step: (_name, fn) => fn(),
		}),
});
