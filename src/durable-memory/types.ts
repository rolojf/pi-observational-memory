import { isAbsolute, win32 } from "node:path";

export const ATTRIBUTIONS = ["user", "agent+user", "agent"] as const;
export const LESSON_TAG_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const TAG_PATTERN = new RegExp(LESSON_TAG_PATTERN);

export type Attribution = typeof ATTRIBUTIONS[number];

export type DecisionDraft = {
	who: Attribution;
	files: string[];
	decision: string;
	reason?: string;
};

export type DecisionRecord = DecisionDraft & {
	id: string;
	date: string;
};

export type LessonDraft = {
	description: string;
	tags: string[];
	body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyList<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
	// Materialize holes so sparse lists cannot claim valid paths or tags.
	return Array.isArray(value) && value.length > 0 && Array.from(value).every(isItem);
}

function isProjectPath(value: unknown): value is string {
	return isNonEmpty(value) && !isAbsolute(value) && !win32.parse(value).root
		&& !/[\\\x00-\x1f\x7f]/.test(value)
		&& value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isLessonTag(value: unknown): value is string {
	return typeof value === "string" && TAG_PATTERN.test(value);
}

export function isDecisionDraft(value: unknown): value is DecisionDraft {
	return isRecord(value) && ATTRIBUTIONS.some((who) => who === value.who)
		&& isNonEmptyList(value.files, isProjectPath) && isNonEmpty(value.decision)
		&& (value.reason === undefined || typeof value.reason === "string");
}

export function isLessonInfo(value: unknown): value is Pick<LessonDraft, "description" | "tags"> {
	return isRecord(value) && isNonEmpty(value.description) && isNonEmptyList(value.tags, isLessonTag);
}

export function isLessonDraft(value: unknown): value is LessonDraft {
	return isLessonInfo(value) && "body" in value && isNonEmpty(value.body);
}
