import type { Client } from "@notionhq/client";
import {
	localDateISO,
	type OverdueTask,
	queryAll,
	SOURCE_DATA_SOURCE_ID,
	SOURCE_DATABASE_URL,
	toOverdueTask,
} from "./overdueLog.js";
import type { StepRunner } from "./runOverdueLog.js";
import { buildReminderMessage, groupByChannel, postToChannel } from "./slackNotify.js";

export type RemindersOptions = {
	notion: Client;
	timeZone: string;
	dryRun: boolean;
	step: StepRunner;
};

export type RemindersSummary = {
	today: string;
	dryRun: boolean;
	dueToday: number;
	overdue: number;
	notifiedChannels: string[];
};

/** Tasks already ticked off today shouldn't be nagged about. */
const NOT_COMPLETE = { property: "Status", status: { does_not_equal: "Complete" } } as const;

function toTasks(pages: Parameters<typeof toOverdueTask>[0][]): OverdueTask[] {
	return pages.map(toOverdueTask).filter((task): task is OverdueTask => task !== null);
}

/**
 * Posts one reminder per `Channel ID`: every open task due today, then the
 * oldest overdue tasks. Reads only; nothing is written to Notion. There is no
 * dedupe, so a manual re-run posts again (a workflow retry replays its steps
 * and doesn't). Keep step names and order stable.
 */
export async function runReminders({ notion, timeZone, dryRun, step }: RemindersOptions): Promise<RemindersSummary> {
	const today = localDateISO(timeZone);
	console.log(`Sending task reminders for ${today} (${timeZone})${dryRun ? " [DRY RUN]" : ""}.`);

	const dueTodayPages = await step("Fetch tasks due today", () =>
		queryAll(notion, SOURCE_DATA_SOURCE_ID, {
			and: [{ property: "Due Date", date: { equals: today } }, NOT_COMPLETE],
		}),
	);
	const overduePages = await step("Fetch overdue tasks", () =>
		queryAll(notion, SOURCE_DATA_SOURCE_ID, {
			and: [{ property: "Due Date", date: { before: today } }, NOT_COMPLETE],
		}),
	);

	const dueToday = toTasks(dueTodayPages);
	// Oldest first; the page ID tiebreak keeps the order stable across replays.
	const overdue = toTasks(overduePages).sort(
		(a, b) => a.dueDate.localeCompare(b.dueDate) || a.pageId.localeCompare(b.pageId),
	);
	console.log(`Found ${dueToday.length} task(s) due today and ${overdue.length} overdue.`);

	const dueTodayByChannel = groupByChannel(dueToday);
	const overdueByChannel = groupByChannel(overdue);
	const channelIds = [...new Set([...dueTodayByChannel.keys(), ...overdueByChannel.keys()])];

	const notifiedChannels: string[] = [];
	for (const channelId of channelIds) {
		const message = buildReminderMessage(
			dueTodayByChannel.get(channelId) ?? [],
			overdueByChannel.get(channelId) ?? [],
			SOURCE_DATABASE_URL,
		);
		if (dryRun) {
			console.log(
				`[DRY RUN] would send reminder to Slack channel ${channelId}:\n${message.text}\n`
					+ `Blocks: ${JSON.stringify({ blocks: message.blocks })}`,
			);
			notifiedChannels.push(channelId);
			continue;
		}

		await step(`Notify Slack channel ${channelId}`, () => postToChannel(channelId, message));
		notifiedChannels.push(channelId);
	}

	return { today, dryRun, dueToday: dueToday.length, overdue: overdue.length, notifiedChannels };
}
