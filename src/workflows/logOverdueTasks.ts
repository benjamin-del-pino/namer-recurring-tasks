import { triggers } from "@notionhq/workers/alpha/triggers";
import { createWorkflow } from "@notionhq/workers/alpha/workflow";
import {
	createLogRow,
	DEFAULT_TIMEZONE,
	dedupeKey,
	LOG_DATA_SOURCE_ID,
	localDateISO,
	type OverdueTask,
	queryAll,
	sleep,
	SOURCE_DATA_SOURCE_ID,
	titleText,
	toOverdueTask,
	WRITE_GAP_MS,
} from "../overdueLog.js";
import { buildMessage, groupByChannel, postToChannel } from "../slackNotify.js";

// Fires on a recurring schedule. Frequency, time of day and timezone are set
// per-workflow in the Notion UI (app.notion.com/developers/workers) after
// deploying — the trigger takes no configuration in code. Set it to daily at
// 06:00 America/Argentina/Buenos_Aires.
export default createWorkflow({
	name: "Log Overdue Recurring Tasks",
	description:
		"Scans NAMER | Active Recurring Tasks and appends a row to Namer Paid Search Overdue Log for every task whose Due Date is in the past.",
	triggers: [triggers.scheduled()],
	handler: async (event, context) => {
		const dryRun = Boolean(process.env.DRY_RUN);
		const timeZone = event.timezone || DEFAULT_TIMEZONE;
		const today = localDateISO(timeZone);
		console.log(`Logging overdue tasks for ${today} (${timeZone})${dryRun ? " [DRY RUN]" : ""}.`);

		const sourcePages = await context.step("Fetch overdue tasks", () =>
			queryAll(context.notion, SOURCE_DATA_SOURCE_ID, {
				property: "Due Date",
				date: { before: today },
			}),
		);
		const tasks = sourcePages
			.map(toOverdueTask)
			.filter((task): task is OverdueTask => task !== null);
		console.log(`Found ${tasks.length} overdue task(s).`);

		// Count what today already has so a re-run only fills the gaps.
		const alreadyLogged = await context.step("Fetch rows already logged today", () =>
			queryAll(context.notion, LOG_DATA_SOURCE_ID, {
				property: "Date Logged",
				date: { equals: today },
			}),
		);
		const remaining = new Map<string, number>();
		for (const page of alreadyLogged) {
			const key = dedupeKey(
				titleText(page.properties["Log Entry"]),
				page.properties["Client"]?.relation?.[0]?.id ?? null,
			);
			remaining.set(key, (remaining.get(key) ?? 0) + 1);
		}
		console.log(`${alreadyLogged.length} row(s) already logged for ${today}.`);

		let created = 0;
		let skipped = 0;
		const notifiable: OverdueTask[] = [];

		for (const task of tasks) {
			const key = dedupeKey(task.taskName, task.clientId);
			const alreadyThere = remaining.get(key) ?? 0;
			if (alreadyThere > 0) {
				remaining.set(key, alreadyThere - 1);
				skipped++;
				continue;
			}

			if (dryRun) {
				console.log(`[DRY RUN] would create log row for "${task.taskName}" (${task.url})`);
				created++;
				notifiable.push(task);
				continue;
			}

			await context.step(`Create log row for task ${task.pageId}`, () =>
				createLogRow(context.notion, task, today),
			);
			created++;
			notifiable.push(task);
			await sleep(WRITE_GAP_MS);
		}

		console.log(
			`Done for ${today}: ${tasks.length} overdue, ${created} created,`
				+ ` ${skipped} skipped as already logged.`,
		);

		const channelGroups = groupByChannel(notifiable);
		for (const [channelId, channelTasks] of channelGroups) {
			const message = buildMessage(channelTasks);
			if (dryRun) {
				console.log(
					`[DRY RUN] would notify Slack channel ${channelId}:\n${message.text}\n`
						+ `Blocks: ${JSON.stringify({ blocks: message.blocks })}`,
				);
				continue;
			}

			await context.step(`Notify Slack channel ${channelId}`, () => postToChannel(channelId, message));
		}
	},
});
