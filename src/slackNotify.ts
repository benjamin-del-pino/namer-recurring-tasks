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

const HEADER = "Hey there, these tasks are overdue from yesterday:";

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
	| { type: "context"; elements: TextObject[] };

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
 * Builds the Slack message for one channel's overdue tasks. Each task is its own
 * section, linked to its Notion page, with a Complete button whose `value` is the
 * page ID and whose `block_id` is `task_<pageId>` so the listener can rewrite
 * just that row after a click.
 */
export function buildMessage(tasks: OverdueTask[]): SlackMessage {
	const bullets = tasks.map((task) => `• <${task.url}|${escapeSlack(task.taskName)}>`).join("\n");

	const blocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text: HEADER } }];

	const shown = tasks.slice(0, MAX_TASK_BLOCKS);
	for (const task of shown) {
		blocks.push({
			type: "section",
			block_id: `task_${task.pageId}`,
			text: { type: "mrkdwn", text: `*<${task.url}|${escapeSlack(task.taskName)}>*` },
			accessory: {
				type: "button",
				action_id: COMPLETE_ACTION_ID,
				style: "primary",
				text: { type: "plain_text", text: "Complete", emoji: true },
				value: task.pageId,
			},
		});
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
