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

/** Builds the Slack message for one channel's overdue tasks, linking each back to its Notion page. */
export function buildMessage(tasks: OverdueTask[]): string {
	const bullets = tasks.map((task) => `• <${task.url}|${task.taskName}>`).join("\n");
	return `Hey there, these tasks are overdue from yesterday:\n${bullets}`;
}

type SlackResponse = {
	ok: boolean;
	error?: string;
};

/** Posts a message to a Slack channel via `chat.postMessage`. */
export async function postToChannel(channelId: string, text: string): Promise<void> {
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
		body: JSON.stringify({ channel: channelId, text }),
	});

	if (!response.ok) {
		throw new Error(`Slack request failed: ${response.status}`);
	}

	const body = (await response.json()) as SlackResponse;
	if (!body.ok) {
		throw new Error(`Slack rejected the message for channel ${channelId}: ${body.error ?? "unknown error"}`);
	}
}
