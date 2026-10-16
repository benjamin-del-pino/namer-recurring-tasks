import type { Client } from "@notionhq/client";
import {
	isNoCadence,
	localDateISO,
	type OverdueTask,
	queryAll,
	SOURCE_DATA_SOURCE_ID,
	sleep,
	SOURCE_DATABASE_URL,
	toOverdueTask,
} from "./overdueLog.js";
import type { StepRunner } from "./runOverdueLog.js";
import { buildChannelPosts, groupByChannel, postChannelMessages } from "./slackNotify.js";

export type RemindersOptions = {
	notion: Client;
	timeZone: string;
	dryRun: boolean;
	step: StepRunner;
	/**
	 * Prepended to every step name. Empty for the afternoon workflow, so its saved
	 * runs keep their names. The morning run sets one because it already has a
	 * step called "Fetch overdue tasks" and names must be unique within a run.
	 */
	stepPrefix?: string;
	/** Overdue tasks to list before the "X other overdue" line. Defaults to the afternoon's 3. */
	maxOverdue?: number;
	/**
	 * Only post to these channels. For the manual tool, to finish a run that
	 * stopped partway without re-posting the channels already done. The
	 * workflows leave it unset (every channel).
	 */
	channels?: string[] | null;
};

export type RemindersSummary = {
	today: string;
	dryRun: boolean;
	dueToday: number;
	overdue: number;
	notifiedChannels: string[];
};

/**
 * Pause before each channel after the first, so ~40 channels stay under the
 * hosted app webhook's rate limit (429 after ~42 calls in ~70s on 2026-10-15).
 * Message order within a channel is the app's job now: it gets the whole
 * channel in one call and posts in order.
 */
const CHANNEL_GAP_MS = 1_000;

/** Tasks already ticked off today shouldn't be nagged about. */
const NOT_COMPLETE = { property: "Status", status: { does_not_equal: "Complete" } } as const;

/** One-off tasks (Cadence "No Cadence") are never posted, as in n8n; Annual and blank Cadence are. */
function toTasks(pages: Parameters<typeof toOverdueTask>[0][]): OverdueTask[] {
	return pages
		.filter((page) => !isNoCadence(page))
		.map(toOverdueTask)
		.filter((task): task is OverdueTask => task !== null);
}

/**
 * Posts each `Channel ID`'s reminder, one Slack message per task under a
 * heading message per section: every open task due today, then those due today
 * that are Run by Agent, then the oldest overdue tasks, with an agent tag in the thread
 * of tasks Run by Agent. Reads only; nothing is written to Notion. There is no
 * dedupe, so a manual re-run posts again (a workflow retry replays its steps
 * and doesn't). Keep step names and order stable.
 */
export async function runReminders({ notion, timeZone, dryRun, step, stepPrefix = "", maxOverdue, channels }: RemindersOptions): Promise<RemindersSummary> {
	const today = localDateISO(timeZone);
	console.log(`Sending task reminders for ${today} (${timeZone})${dryRun ? " [DRY RUN]" : ""}.`);

	// Each fetch step returns the slim tasks, not the Notion pages: on production
	// (2026-10-15) the full pages came to ~480 KB for one step, and every scheduled
	// run died silently right after that step without saving its result.
	const dueToday = await step(`${stepPrefix}Fetch tasks due today`, async () =>
		toTasks(await queryAll(notion, SOURCE_DATA_SOURCE_ID, {
			and: [{ property: "Due Date", date: { equals: today } }, NOT_COMPLETE],
		})),
	);
	const overdueTasks = await step(`${stepPrefix}Fetch overdue tasks`, async () =>
		toTasks(await queryAll(notion, SOURCE_DATA_SOURCE_ID, {
			and: [{ property: "Due Date", date: { before: today } }, NOT_COMPLETE],
		})),
	);

	// Oldest first; the page ID tiebreak keeps the order stable across replays.
	const overdue = [...overdueTasks].sort(
		(a, b) => a.dueDate.localeCompare(b.dueDate) || a.pageId.localeCompare(b.pageId),
	);
	console.log(`Found ${dueToday.length} task(s) due today and ${overdue.length} overdue.`);

	const dueTodayByChannel = groupByChannel(dueToday);
	const overdueByChannel = groupByChannel(overdue);
	const channelIds = [...new Set([...dueTodayByChannel.keys(), ...overdueByChannel.keys()])]
		.filter((channelId) => !channels || channels.includes(channelId));
	if (channels) {
		const unknown = channels.filter((channelId) => !dueTodayByChannel.has(channelId) && !overdueByChannel.has(channelId));
		console.log(`Limited to ${channelIds.length} of the ${channels.length} requested channel(s).`);
		if (unknown.length > 0) console.warn(`No tasks today for requested channel(s): ${unknown.join(", ")}.`);
	}

	const notifiedChannels: string[] = [];
	for (const channelId of channelIds) {
		const posts = buildChannelPosts(
			dueTodayByChannel.get(channelId) ?? [],
			overdueByChannel.get(channelId) ?? [],
			SOURCE_DATABASE_URL,
			maxOverdue,
		);
		console.log(`${posts.length} message(s) for Slack channel ${channelId}.`);

		const messages = posts.map((post) => ({ message: post.message, thread: post.kind === "task" ? post.thread : null }));
		const name = `${stepPrefix}Notify channel ${channelId}`;
		if (dryRun) {
			for (const [index, { message, thread }] of messages.entries()) {
				console.log(
					`[DRY RUN] ${name}, message ${index + 1}:\n${message.text}${thread ? `\n  thread: ${thread.text}` : ""}\n`
						+ `Blocks: ${JSON.stringify({ blocks: message.blocks })}`,
				);
			}
		} else {
			// One step per channel: the whole channel is one call to the hosted app.
			// The pause sits inside the step, so a replayed step doesn't wait again.
			const isFirst = notifiedChannels.length === 0;
			await step(name, async () => {
				if (!isFirst) await sleep(CHANNEL_GAP_MS);
				await postChannelMessages(channelId, messages);
			});
		}
		notifiedChannels.push(channelId);
	}

	return { today, dryRun, dueToday: dueToday.length, overdue: overdue.length, notifiedChannels };
}
