import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDecisionDraft, isLessonDraft, type DecisionDraft, type DecisionRecord, type LessonDraft } from "./types.js";

const ADR_FILE = "ADR.jsonl";
const LOCK_ATTEMPTS = 100;
const LOCK_DELAY_MS = 20;
const LESSON_ATTEMPTS = 10;
const SLUG_LENGTH = 80;
const NEWLINE_BYTE = 0x0a;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkDecisions(drafts: unknown): asserts drafts is DecisionDraft[] {
	if (!Array.isArray(drafts) || !Array.from(drafts).every(isDecisionDraft)) {
		throw new TypeError("Invalid decision structure or repository-relative file path");
	}
}

function checkLessons(drafts: unknown): asserts drafts is LessonDraft[] {
	if (!Array.isArray(drafts) || !Array.from(drafts).every(isLessonDraft)) {
		throw new TypeError("Invalid lesson structure");
	}
}

function checkDate(date: Date): void {
	if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
		throw new TypeError("Invalid capture date");
	}
}

async function projectDir(projectRoot: string): Promise<string> {
	if (typeof projectRoot !== "string" || !isAbsolute(projectRoot) || projectRoot.includes("\0")) {
		throw new TypeError("Project root must be an absolute directory path");
	}

	const root = await realpath(projectRoot);
	if (!(await lstat(root)).isDirectory()) throw new Error("Project root must be a directory");
	return root;
}

function hasCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

async function lockAdr(root: string) {
	const path = join(root, `${ADR_FILE}.lock`);
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			return { handle: await open(path, "wx"), path };
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			if (attempt < LOCK_ATTEMPTS - 1) await delay(LOCK_DELAY_MS);
		}
	}

	// Never steal a lock: the previous writer may still be appending.
	throw new Error(`Timed out waiting for ${ADR_FILE} writer lock`);
}

export async function writeDecisions(
	projectRoot: string,
	drafts: DecisionDraft[],
	capturedAt: Date,
	canWrite: () => boolean = () => true,
): Promise<DecisionRecord[]> {
	checkDecisions(drafts);
	checkDate(capturedAt);
	if (drafts.length === 0 || !canWrite()) return [];

	const root = await projectDir(projectRoot);
	const records = drafts.map((draft): DecisionRecord => ({
		id: randomUUID(),
		date: capturedAt.toISOString(),
		who: draft.who,
		files: [...draft.files],
		decision: draft.decision,
		...(draft.reason === undefined ? {} : { reason: draft.reason }),
	}));
	const payload = records.map((record) => `${JSON.stringify(record)}\n`).join("");
	const lock = await lockAdr(root);
	try {
		if (!canWrite()) return [];

		// O_NOFOLLOW rejects symlink targets; the lock keeps cooperating batches intact.
		const file = await open(join(root, ADR_FILE), constants.O_RDWR | constants.O_APPEND
			| constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.nlink !== 1) throw new Error("ADR target must be an unshared regular file");

			// Inspect only the last byte, never parse or reconcile historical rows.
			let separator = "";
			if (stat.size > 0) {
				const tail = Buffer.alloc(1);
				await file.read(tail, 0, 1, stat.size - 1);
				if (tail[0] !== NEWLINE_BYTE) separator = "\n";
			}

			if (!canWrite()) return [];
			await file.writeFile(separator + payload, "utf8");
		} finally {
			await file.close();
		}
	} finally {
		await lock.handle.close();
		await unlink(lock.path);
	}

	return records;
}

function localDatetime(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
		+ `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		+ `.${String(date.getMilliseconds()).padStart(3, "0")}`
		+ `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
	const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
		.formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
	return `${stamp} # ${zone}`;
}

function lessonText(draft: LessonDraft, datetime: string): string {
	// JSON quoted strings are YAML-safe, including embedded newlines and delimiters.
	return `---\ndescription: ${JSON.stringify(draft.description)}\ndatetime: ${datetime}\n`
		+ `tags: [${draft.tags.join(", ")}]\n---\n\n${draft.body}\n`;
}

function lessonSlug(description: string): string {
	return description.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-").slice(0, SLUG_LENGTH).replace(/^-|-$/g, "") || "lesson";
}

async function lessonDir(root: string): Promise<string> {
	const path = join(root, "MEMORIES");
	try {
		await mkdir(path);
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
	}

	if (!(await lstat(path)).isDirectory() || await realpath(path) !== resolve(root, "MEMORIES")) {
		throw new Error("MEMORIES must be a project-local directory, not a symlink");
	}
	return path;
}

async function saveLesson(
	root: string,
	draft: LessonDraft,
	datetime: string,
	canWrite: () => boolean,
): Promise<string | undefined> {
	const slug = lessonSlug(draft.description);
	const content = lessonText(draft, datetime);
	for (let attempt = 0; attempt < LESSON_ATTEMPTS; attempt++) {
		const suffix = attempt === 0 ? "" : `-${randomUUID()}`;
		const path = join(root, `${slug}${suffix}.frontmatter.md`);
		let file;
		if (!canWrite()) return;
		try {
			file = await open(path, "wx");
		} catch (error) {
			if (hasCode(error, "EEXIST")) continue;
			throw error;
		}

		let written = false;
		try {
			if (!canWrite()) return;
			await file.writeFile(content, "utf8");
			written = true;
		} finally {
			await file.close();
			if (!written) await unlink(path);
		}
		return path;
	}

	throw new Error("Could not create a unique lesson filename");
}

export async function writeLessons(
	projectRoot: string,
	drafts: LessonDraft[],
	capturedAt: Date,
	canWrite: () => boolean = () => true,
): Promise<string[]> {
	checkLessons(drafts);
	checkDate(capturedAt);
	if (drafts.length === 0 || !canWrite()) return [];

	const project = await projectDir(projectRoot);
	if (!canWrite()) return [];
	const root = await lessonDir(project);
	const datetime = localDatetime(capturedAt);
	const paths: string[] = [];
	for (const draft of drafts) {
		const path = await saveLesson(root, draft, datetime, canWrite);
		if (path === undefined) break;
		paths.push(path);
	}
	return paths;
}
