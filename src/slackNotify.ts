import { TerminalError } from "@notionhq/workers/alpha/error";
import type { OverdueTask } from "./overdueLog.js";

/** Groups tasks by their source `Channel ID`, preserving input order. Tasks with no channel are skipped. */
export function groupByChannel(tasks: OverdueTask[]): Map<string, OverdueTask[]> {
	const groups = new Map<string, OverdueTask[]>();

	for (const task of tasks) {
		if (!task.channelId) {
			console.warn(`Task "${task.taskName}" (${task.url}) has no Channel ID; skipping Slack notification.`);
			continue;
		}

		const existing = groups.get(task.channelId);
		if (existing) {
			existing.push(task);
		} else {
			groups.set(task.channelId, [task]);
		}
	}

	return groups;
}

/**
 * `action_id` on every Complete button. The click listener worker routes on it,
 * so renaming it here silently breaks clicks. It must stay distinct from the
 * live n8n handler's `complete_task` / `complete_task_recurring`: the Slack app
 * is shared, and n8n ignores action_ids it doesn't know.
 */
export const COMPLETE_ACTION_ID = "complete_task_recurring_worker";

/** Slack caps a message at 50 blocks; this leaves room for the header and overflow line. */
const MAX_TASK_BLOCKS = 45;

const HEADER = "Hey there, these tasks are overdue:";

// Block Kit types are hand-rolled; only the shapes this module emits are modelled.
type TextObject = { type: "mrkdwn" | "plain_text"; text: string; emoji?: boolean };
type Block =
	| {
			type: "section";
			block_id?: string;
			text: TextObject;
			accessory?: {
				type: "button";
				action_id: string;
				style: "primary";
				text: TextObject;
				value: string;
			};
	  }
	| { type: "context"; elements: TextObject[] }
	| { type: "divider" };

export type SlackMessage = {
	/** Fallback shown in notifications and clients that can't render blocks. */
	text: string;
	blocks: Block[];
};

/** Escapes the three characters Slack treats as control characters in mrkdwn. */
function escapeSlack(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * "Owner: A, B". Falls back to "unknown" when the page has owners but Notion
 * returned no names (the token lacks user-info access), and "none" when unset.
 */
function ownerLabel(task: OverdueTask): string {
	if (task.ownerNames.length > 0) return `Owner: ${escapeSlack(task.ownerNames.join(", "))}`;
	return task.ownerIds.length > 0 ? "Owner: unknown" : "Owner: none";
}

function bulletList(tasks: OverdueTask[]): string {
	return tasks.map((task) => `• <${task.url}|${escapeSlack(task.taskName)}> (${ownerLabel(task)})`).join("\n");
}

/**
 * One task as its own section, linked to its Notion page with its owner on a
 * second line (the listener keeps this text when it marks the row done), and a Complete button
 * whose `value` is the page ID and whose `block_id` is `task_<pageId>` so the
 * listener can rewrite just that row after a click.
 */
function taskBlock(task: OverdueTask): Block {
	return {
		type: "section",
		block_id: `task_${task.pageId}`,
		text: { type: "mrkdwn", text: `*<${task.url}|${escapeSlack(task.taskName)}>*\n${ownerLabel(task)}` },
		accessory: {
			type: "button",
			action_id: COMPLETE_ACTION_ID,
			style: "primary",
			text: { type: "plain_text", text: "Complete", emoji: true },
			value: task.pageId,
		},
	};
}

/** Builds the Slack message for one channel's overdue tasks. */
export function buildMessage(tasks: OverdueTask[]): SlackMessage {
	const bullets = bulletList(tasks);

	const blocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text: HEADER } }];

	const shown = tasks.slice(0, MAX_TASK_BLOCKS);
	for (const task of shown) {
		blocks.push(taskBlock(task));
	}

	const hidden = tasks.length - shown.length;
	if (hidden > 0) {
		blocks.push({
			type: "context",
			elements: [
				{ type: "mrkdwn", text: `_and ${hidden} more not shown - Slack caps a message at 50 blocks._` },
			],
		});
	}

	return { text: `${HEADER}\n${bullets}`, blocks };
}

/**
 * Due-today tasks shown in a reminder. With the header, overflow line, divider,
 * overdue section and its overflow line, the message stays under Slack's 50 blocks.
 */
const MAX_DUE_TODAY_BLOCKS = 40;

/** Overdue tasks shown in a reminder; the rest are counted with a link to Notion. */
const MAX_REMINDER_OVERDUE = 3;

const DUE_TODAY_HEADER = "Reminder: these tasks are due today:";
const NOTHING_DUE_TODAY = "Nothing due today.";
const STILL_OVERDUE_HEADER = "Still overdue:";

/**
 * Builds the afternoon reminder for one channel: every task due today, then the
 * first `MAX_REMINDER_OVERDUE` overdue tasks (callers pass them oldest first)
 * and a count of the rest with a link to the database.
 */
export function buildReminderMessage(
	dueToday: OverdueTask[],
	overdue: OverdueTask[],
	databaseUrl: string,
): SlackMessage {
	const blocks: Block[] = [];
	const textParts: string[] = [];

	if (dueToday.length > 0) {
		blocks.push({ type: "section", text: { type: "mrkdwn", text: DUE_TODAY_HEADER } });
		const shown = dueToday.slice(0, MAX_DUE_TODAY_BLOCKS);
		for (const task of shown) {
			blocks.push(taskBlock(task));
		}
		const hidden = dueToday.length - shown.length;
		if (hidden > 0) {
			blocks.push({
				type: "context",
				elements: [{ type: "mrkdwn", text: `_and ${hidden} more due today, <${databaseUrl}|check Notion>._` }],
			});
		}
		textParts.push(`${DUE_TODAY_HEADER}\n${bulletList(dueToday)}`);
	} else {
		blocks.push({ type: "section", text: { type: "mrkdwn", text: NOTHING_DUE_TODAY } });
		textParts.push(NOTHING_DUE_TODAY);
	}

	if (overdue.length > 0) {
		const shown = overdue.slice(0, MAX_REMINDER_OVERDUE);
		blocks.push({ type: "divider" });
		blocks.push({ type: "section", text: { type: "mrkdwn", text: STILL_OVERDUE_HEADER } });
		for (const task of shown) {
			blocks.push(taskBlock(task));
		}

		let overflow = "";
		const others = overdue.length - shown.length;
		if (others > 0) {
			overflow = others === 1
				? "There is 1 other overdue task"
				: `There are ${others} other overdue tasks`;
			blocks.push({
				type: "context",
				elements: [{ type: "mrkdwn", text: `${overflow}, <${databaseUrl}|check Notion>.` }],
			});
		}
		textParts.push(
			`${STILL_OVERDUE_HEADER}\n${bulletList(shown)}${overflow ? `\n${overflow}, check Notion.` : ""}`,
		);
	}

	return { text: textParts.join("\n\n"), blocks };
}

type SlackResponse = {
	ok: boolean;
	error?: string;
};

/** Posts a Block Kit message to a Slack channel via `chat.postMessage`. */
export async function postToChannel(channelId: string, message: SlackMessage): Promise<void> {
	const token = process.env.SLACK_API_KEY;
	if (!token) {
		throw new TerminalError("SLACK_API_KEY is not set; add it to .env (and push it to the deployed worker).");
	}

	const response = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify({ channel: channelId, text: message.text, blocks: message.blocks }),
	});

	if (!response.ok) {
		throw new Error(`Slack request failed: ${response.status}`);
	}

	const body = (await response.json()) as SlackResponse;
	if (!body.ok) {
		throw new Error(`Slack rejected the message for channel ${channelId}: ${body.error ?? "unknown error"}`);
	}
}
