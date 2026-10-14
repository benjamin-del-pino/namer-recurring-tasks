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

/** Overdue tasks posted by the afternoon reminder; the rest are counted in one closing message. */
export const MAX_REMINDER_OVERDUE = 3;

export type TaskLabel = "Due today" | "Overdue";

/** One post in a channel's reminder: a task with its Complete button (and maybe a thread reply), or the closing count. */
export type ChannelPost =
	| { kind: "task"; task: OverdueTask; message: SlackMessage; thread: SlackMessage | null }
	| { kind: "overflow"; others: number; message: SlackMessage };

/** One task as its own message: a heading line, then the task row with its Complete button. */
export function buildTaskMessage(task: OverdueTask, label: TaskLabel): SlackMessage {
	return {
		text: `${label}: ${task.taskName} (${ownerLabel(task)})`,
		blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${label}*` } }, taskBlock(task)],
	};
}

/**
 * The thread reply under a task whose `Run by` is Agent, else null. Tags
 * `AGENT_SLACK_USER_ID` when it is set; until the agent is chosen it reads
 * "[Agent]". The tag is in `text` too, because a mention only notifies (and an
 * agent only reads) from there.
 */
export function buildAgentThread(task: OverdueTask, agentUserId = process.env.AGENT_SLACK_USER_ID?.trim() ?? ""): SlackMessage | null {
	if (task.runBy !== "Agent") return null;
	const text = `${agentUserId ? `<@${agentUserId}>` : "[Agent]"} this is for you.`;
	return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

/** The closing message when the afternoon cap leaves overdue tasks out. No button. */
export function buildOverflowMessage(others: number, databaseUrl: string): SlackMessage {
	const overflow = others === 1 ? "There is 1 other overdue task" : `There are ${others} other overdue tasks`;
	return {
		text: `${overflow}, check Notion.`,
		blocks: [{ type: "section", text: { type: "mrkdwn", text: `${overflow}, <${databaseUrl}|check Notion>.` } }],
	};
}

/**
 * Everything one channel's reminder posts, in order: one message per task due
 * today, then one per overdue task (callers pass them oldest first) up to
 * `maxOverdue`, then a count of the rest with a link to the database. The
 * afternoon run keeps the default of 3; the morning run passes Infinity. Tasks
 * Run by Agent carry a thread reply.
 */
export function buildChannelPosts(
	dueToday: OverdueTask[],
	overdue: OverdueTask[],
	databaseUrl: string,
	maxOverdue: number = MAX_REMINDER_OVERDUE,
): ChannelPost[] {
	const task = (t: OverdueTask, label: TaskLabel): ChannelPost => ({
		kind: "task",
		task: t,
		message: buildTaskMessage(t, label),
		thread: buildAgentThread(t),
	});
	const shown = overdue.slice(0, Math.max(0, maxOverdue));
	const posts = [...dueToday.map((t) => task(t, "Due today")), ...shown.map((t) => task(t, "Overdue"))];
	const others = overdue.length - shown.length;
	if (others > 0) posts.push({ kind: "overflow", others, message: buildOverflowMessage(others, databaseUrl) });
	return posts;
}

type SlackResponse = {
	ok: boolean;
	error?: string;
	ts?: string;
};

/**
 * Posts through the Slack-hosted app's webhook. The app posts the message and
 * owns its Complete buttons (instant "Completed by", Notion write handed to the
 * recurring-tasks-slack-actions worker), and posts `thread` as a reply under it.
 * The webhook answers before the app has posted, so an app-side failure (bad
 * token, channel the app can't reach, failed thread reply) shows in the app's
 * logs (`slack activity`), not as an error here.
 */
async function postViaHostedApp(url: string, channelId: string, message: SlackMessage, thread: SlackMessage | null): Promise<void> {
	const secret = process.env.RELAY_SECRET;
	if (!secret) {
		throw new TerminalError("RELAY_SECRET is not set; it must match the Slack app's RELAY_SECRET.");
	}

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			token: secret,
			channel: channelId,
			text: message.text,
			blocks_json: JSON.stringify(message.blocks),
			// Always sent, "" for none, so the trigger's {{data.thread_json}} always resolves.
			thread_json: thread ? JSON.stringify({ text: thread.text, blocks: thread.blocks }) : "",
		}),
	});

	if (!response.ok) {
		throw new Error(`Slack app webhook failed for channel ${channelId}: ${response.status}`);
	}

	const body = (await response.json().catch(() => ({}))) as SlackResponse;
	if (body.ok === false) {
		throw new Error(`Slack app webhook rejected the message for channel ${channelId}: ${body.error ?? "unknown error"}`);
	}
}

async function chatPostMessage(token: string, payload: Record<string, unknown>): Promise<SlackResponse> {
	const response = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		throw new Error(`Slack request failed: ${response.status}`);
	}
	return (await response.json()) as SlackResponse;
}

/**
 * Posts a Block Kit message to a Slack channel, plus `thread` as a reply under
 * it when given. With `SLACK_POST_WEBHOOK_URL` set it goes through the hosted
 * Slack app; otherwise it falls back to `chat.postMessage` with `SLACK_API_KEY`
 * (the older Notifier/Tester app). On the fallback a failed thread reply is
 * logged, not thrown: the task message went out, and a retry would post it twice.
 */
export async function postToChannel(channelId: string, message: SlackMessage, thread: SlackMessage | null = null): Promise<void> {
	const hostedAppUrl = process.env.SLACK_POST_WEBHOOK_URL;
	if (hostedAppUrl) {
		console.log(`Posting to ${channelId} via the hosted Slack app webhook.`);
		return postViaHostedApp(hostedAppUrl, channelId, message, thread);
	}
	console.log(`Posting to ${channelId} via chat.postMessage (SLACK_POST_WEBHOOK_URL is empty or unset in this runtime).`);

	const token = process.env.SLACK_API_KEY;
	if (!token) {
		throw new TerminalError("SLACK_API_KEY is not set; add it to .env (and push it to the deployed worker).");
	}

	const body = await chatPostMessage(token, { channel: channelId, text: message.text, blocks: message.blocks });
	if (!body.ok) {
		throw new Error(`Slack rejected the message for channel ${channelId}: ${body.error ?? "unknown error"}`);
	}
	if (!thread) return;

	try {
		const reply = await chatPostMessage(token, { channel: channelId, thread_ts: body.ts, text: thread.text, blocks: thread.blocks });
		if (!reply.ok) console.warn(`Thread reply failed in ${channelId} (ts ${body.ts}): ${reply.error ?? "unknown error"}`);
	} catch (error) {
		console.warn(`Thread reply failed in ${channelId} (ts ${body.ts}): ${String(error)}`);
	}
}
