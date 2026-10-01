import type { Client } from "@notionhq/client";
import type {
	CreatePageParameters,
	QueryDataSourceParameters,
} from "@notionhq/client/build/src/api-endpoints.js";

type QueryFilter = QueryDataSourceParameters["filter"];
type PageProperties = CreatePageParameters["properties"];

/**
 * `🔁 Workers Test - NAMER | Active Recurring Tasks` — sandbox replica of the
 * tasks we scan. Swap for `26e05ce3-3757-83ef-9481-8751c9ba8766` (the real
 * `🔁 NAMER | Active Recurring Tasks`) before going live.
 */
export const SOURCE_DATA_SOURCE_ID = "d370848d-c842-40ed-965b-6a57654a3fe3";

/**
 * Link to the source database, used in Slack's "check Notion" line. Swap for
 * `https://app.notion.com/p/0da05ce337578386931301e9d2c4db4d` (the real
 * `🔁 NAMER | Active Recurring Tasks`) along with `SOURCE_DATA_SOURCE_ID`.
 */
export const SOURCE_DATABASE_URL = "https://app.notion.com/p/d042b3500c8a4d8e8724cde42c6ce2e1";

/**
 * `⚠️ Workers Test - Namer Paid Search Overdue Log` — sandbox replica of the
 * log we append to. Swap for `e6805ce3-3757-82b5-b766-8713fcb4c60d` (the real
 * `⚠️ Namer Paid Search Overdue Log`) before going live.
 */
export const LOG_DATA_SOURCE_ID = "164d96fc-482f-41f8-9f5a-cc6d6bb2cd37";

/** Argentina has had no DST since 2009, so this zone is a fixed UTC-3. */
export const DEFAULT_TIMEZONE = "America/Argentina/Buenos_Aires";

/** Notion's public API allows roughly 3 requests/second. */
export const WRITE_GAP_MS = 350;

/** Notion rejects rich text and titles longer than this. */
const TEXT_LIMIT = 2000;

/** The log's `Cadence` select has this option; the source leaves Cadence blank on some rows. */
const CADENCE_FALLBACK = "No Cadence";

type NotionPage = {
	id: string;
	url: string;
	properties: Record<string, any>;
};

/** A source task that is overdue, reduced to the fields the log needs. */
export type OverdueTask = {
	pageId: string;
	url: string;
	taskName: string;
	clientId: string | null;
	cadence: string;
	status: string | null;
	dueDate: string;
	notes: string;
	ownerIds: string[];
	/** Owner display names, for Slack. Empty if the token can't read user info. */
	ownerNames: string[];
	channelId: string | null;
};

/**
 * Today's date as `YYYY-MM-DD` in the given IANA zone.
 *
 * Falls back to fixed UTC-3 arithmetic if the runtime's ICU build doesn't know
 * the zone, which is exact for Argentina.
 */
export function localDateISO(timeZone: string, now: Date = new Date()): string {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(now);
		const get = (type: string) => parts.find((p) => p.type === type)?.value;
		const year = get("year");
		const month = get("month");
		const day = get("day");
		if (!year || !month || !day) {
			throw new Error(`Incomplete date parts for time zone ${timeZone}`);
		}
		return `${year}-${month}-${day}`;
	} catch (error) {
		console.warn(
			`Could not resolve time zone ${timeZone} (${String(error)}); falling back to fixed UTC-3.`,
		);
		return new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
	}
}

/** Whole days between two `YYYY-MM-DD` dates. */
function daysBetween(from: string, to: string): number {
	const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
	return Math.round(ms / 86_400_000);
}

function plainText(property: unknown): string {
	const richText = (property as { rich_text?: { plain_text?: string }[] })?.rich_text;
	if (!Array.isArray(richText)) return "";
	return richText.map((t) => t.plain_text ?? "").join("").trim();
}

export function titleText(property: unknown): string {
	const title = (property as { title?: { plain_text?: string }[] })?.title;
	if (!Array.isArray(title)) return "";
	return title.map((t) => t.plain_text ?? "").join("").trim();
}

function truncate(value: string): string {
	return value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value;
}

function richText(value: string) {
	return { rich_text: [{ text: { content: truncate(value) } }] };
}

/**
 * Retries transient Notion failures (429, 409 conflicts, 5xx) with backoff,
 * honouring `Retry-After` when the API sends it.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (error: any) {
			lastError = error;
			const status: number | undefined = error?.status;
			const retryable = status === 429 || status === 409 || (status !== undefined && status >= 500);
			if (!retryable || attempt === attempts) break;

			const retryAfter = Number(error?.headers?.["retry-after"]);
			const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
				? retryAfter * 1000
				: 500 * 2 ** (attempt - 1);
			console.warn(`Notion request failed (status ${status}); retrying in ${delayMs}ms.`);
			await sleep(delayMs);
		}
	}

	throw lastError;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pages through a data source query, collecting every result. */
export async function queryAll(
	notion: Client,
	dataSourceId: string,
	filter: QueryFilter,
): Promise<NotionPage[]> {
	const pages: NotionPage[] = [];
	let cursor: string | undefined;

	do {
		const response = await withRetry(() =>
			notion.dataSources.query({
				data_source_id: dataSourceId,
				filter,
				page_size: 100,
				start_cursor: cursor,
			}),
		);
		for (const result of response.results) {
			// Partial responses (no `properties`) come back when the integration
			// lacks access to a page; skip rather than crash on them.
			if ("properties" in result) {
				pages.push(result as NotionPage);
			}
		}
		cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
	} while (cursor);

	return pages;
}

/** Reduces a source page to the fields the log needs. */
export function toOverdueTask(page: NotionPage): OverdueTask | null {
	const dueDate: string | undefined = page.properties["Due Date"]?.date?.start;
	if (!dueDate) return null;

	// Notion only fills in `name` when the integration has the "Read user
	// information" capability; otherwise each person is just an ID.
	const owners: { id?: string; name?: string | null }[] = page.properties["Owner"]?.people ?? [];

	return {
		pageId: page.id,
		url: page.url,
		taskName: titleText(page.properties["Task Name"]),
		clientId: page.properties["Client"]?.relation?.[0]?.id ?? null,
		cadence: page.properties["Cadence"]?.select?.name ?? CADENCE_FALLBACK,
		status: page.properties["Status"]?.status?.name ?? null,
		dueDate: dueDate.slice(0, 10),
		notes: plainText(page.properties["Notes"]),
		ownerIds: owners.map((person) => person.id).filter((id): id is string => Boolean(id)),
		ownerNames: owners.map((person) => person.name?.trim()).filter((name): name is string => Boolean(name)),
		channelId: plainText(page.properties["Channel ID"]) || null,
	};
}

/**
 * Identifies a log row. The log has no back-relation to the source task, so
 * title + client is the best available key — and it is not unique (several
 * distinct tasks share a title for one client), which is why callers count
 * matches rather than treating the key as a set membership test.
 */
export function dedupeKey(taskName: string, clientId: string | null): string {
	return `${taskName}|${clientId ?? ""}`;
}

/** Builds the log row properties for an overdue task. */
export function logProperties(task: OverdueTask, today: string): PageProperties {
	const overdueBy = daysBetween(task.dueDate, today);
	const notes = task.notes
		|| `Overdue since ${task.dueDate} (${overdueBy} day${overdueBy === 1 ? "" : "s"})`
			+ ` · Status: ${task.status ?? "not set"} · Cadence: ${task.cadence}`;

	return {
		"Log Entry": { title: [{ text: { content: truncate(task.taskName) } }] },
		Client: { relation: task.clientId ? [{ id: task.clientId }] : [] },
		"Date Logged": { date: { start: today } },
		Cadence: { select: { name: task.cadence } },
		Month: richText(today.slice(0, 7)),
		Year: richText(today.slice(0, 4)),
		Owner: { people: task.ownerIds.map((id) => ({ id })) },
		Notes: richText(notes),
	};
}

/**
 * Creates one log row for an overdue task, retrying transient Notion failures.
 */
export async function createLogRow(notion: Client, task: OverdueTask, today: string): Promise<void> {
	await withRetry(() =>
		notion.pages.create({
			parent: { type: "data_source_id", data_source_id: LOG_DATA_SOURCE_ID },
			properties: logProperties(task, today),
		}),
	);
}
