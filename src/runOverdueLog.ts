import type { Client } from "@notionhq/client";
import {
	createLogRow,
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
} from "./overdueLog.js";
import { runReminders } from "./runReminders.js";

/**
 * Runs one unit of work. The workflow passes `context.step` (durable, replayed
 * on retry); the manual tool passes a plain call-through, since tools have no
 * step API. Keep step names and order stable: saved workflow runs depend on them.
 */
export type StepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type OverdueLogOptions = {
	notion: Client;
	timeZone: string;
	dryRun: boolean;
	step: StepRunner;
};

export type OverdueLogSummary = {
	today: string;
	dryRun: boolean;
	overdue: number;
	created: number;
	skipped: number;
	dueToday: number;
	notifiedChannels: string[];
};

/**
 * Logs every overdue task not already logged today, then posts the same Slack
 * message as the afternoon reminder (due today first, then the oldest overdue
 * tasks) via runReminders. Safe to re-run for the log: its own rows for today
 * dedupe the writes. The Slack message is not deduped, so a manual re-run posts
 * again, like the afternoon one.
 */
export async function runOverdueLog({ notion, timeZone, dryRun, step }: OverdueLogOptions): Promise<OverdueLogSummary> {
	const today = localDateISO(timeZone);
	console.log(`Logging overdue tasks for ${today} (${timeZone})${dryRun ? " [DRY RUN]" : ""}.`);

	const sourcePages = await step("Fetch overdue tasks", () =>
		queryAll(notion, SOURCE_DATA_SOURCE_ID, {
			property: "Due Date",
			date: { before: today },
		}),
	);
	const tasks = sourcePages
		.map(toOverdueTask)
		.filter((task): task is OverdueTask => task !== null);
	console.log(`Found ${tasks.length} overdue task(s).`);

	// Count what today already has so a re-run only fills the gaps.
	const alreadyLogged = await step("Fetch rows already logged today", () =>
		queryAll(notion, LOG_DATA_SOURCE_ID, {
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
			continue;
		}

		await step(`Create log row for task ${task.pageId}`, () => createLogRow(notion, task, today));
		created++;
		await sleep(WRITE_GAP_MS);
	}

	console.log(
		`Done for ${today}: ${tasks.length} overdue, ${created} created,`
			+ ` ${skipped} skipped as already logged.`,
	);

	const reminders = await runReminders({ notion, timeZone, dryRun, step, stepPrefix: "Morning: ", maxOverdue: Number.POSITIVE_INFINITY });

	return {
		today,
		dryRun,
		overdue: tasks.length,
		created,
		skipped,
		dueToday: reminders.dueToday,
		notifiedChannels: reminders.notifiedChannels,
	};
}
