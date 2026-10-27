import { existsSync, statSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeDecisions, writeLessons } from "../src/durable-memory/storage.js";
import { ATTRIBUTIONS, LESSON_TAG_PATTERN, isDecisionDraft, isLessonDraft, type DecisionDraft, type DecisionRecord, type LessonDraft } from "../src/durable-memory/types.js";

const capturedAt = new Date("2026-07-20T13:14:15.123Z");
const decision: DecisionDraft = {
	who: "agent+user",
	files: ["src/runtime.ts", "tests/runtime.test.ts"],
	decision: "Keep attribution as supplied",
};
const lesson: LessonDraft = {
	description: "Preserve capture time",
	tags: ["memory", "capture-time"],
	body: "# Capture time\n\nDates describe capture, not the original decision.",
};

let sandbox: string;
let root: string;

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "om-durable-storage-"));
	root = join(sandbox, "project");
	await mkdir(root);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(sandbox, { recursive: true, force: true });
});

async function readDecisions(): Promise<DecisionRecord[]> {
	const content = await readFile(join(root, "ADR.jsonl"), "utf8");
	return content.trimEnd().split("\n").map((line) => JSON.parse(line));
}

describe("decision persistence", () => {
	it("roundtrips standard JSON escaping, Unicode, multiple paths, and optional reasons", async () => {
		const escaped = 'quotes " slash \\ tab\t newline\nCR\r Unicode 日本語 😀\u0000';
		const drafts: DecisionDraft[] = [
			{ ...decision, decision: escaped, reason: escaped },
			{ ...decision, who: "user" },
			{ ...decision, who: "agent", reason: "" },
		];
		const saved = await writeDecisions(root, drafts, capturedAt);
		expect(await readDecisions()).toEqual(saved);
		expect(saved.map(({ id, date, ...draft }) => draft)).toEqual(drafts);
		expect(saved.every((record) => record.date === capturedAt.toISOString())).toBe(true);
		expect(saved.every((record) => /^[0-9a-f-]{36}$/.test(record.id))).toBe(true);
		expect(new Set(saved.map((record) => record.id)).size).toBe(3);
		expect(Object.keys(saved[0]).sort()).toEqual(["date", "decision", "files", "id", "reason", "who"]);
		expect(Object.hasOwn(saved[1], "reason")).toBe(false);
		const content = await readFile(join(root, "ADR.jsonl"), "utf8");
		expect(content.split("\n")).toHaveLength(4);
		expect(content.endsWith("\n")).toBe(true);
		expect(await readdir(root)).toEqual(["ADR.jsonl"]);
	});

	it("appends without reconciliation, deduplication, or historical parsing", async () => {
		const prefix = 'not a valid historical row\n{"id":"old","status":"legacy"}\n';
		await writeFile(join(root, "ADR.jsonl"), prefix);
		const first = await writeDecisions(root, [decision], capturedAt);
		const second = await writeDecisions(root, [decision], capturedAt);
		expect(first[0].id).not.toBe(second[0].id);
		expect(await readFile(join(root, "ADR.jsonl"), "utf8")).toBe(prefix
			+ JSON.stringify(first[0]) + "\n" + JSON.stringify(second[0]) + "\n");
	});

	it.each([
		'{"id":"prior","decision":"valid prior row"}',
		'{"malformed":',
	])("separates an unterminated historical tail without parsing it: %s", async (tail) => {
		await writeFile(join(root, "ADR.jsonl"), tail);
		const saved = await writeDecisions(root, [decision], capturedAt);
		expect(await readFile(join(root, "ADR.jsonl"), "utf8"))
			.toBe(`${tail}\n${JSON.stringify(saved[0])}\n`);
	});

	it("appends to an existing empty log without a leading blank row", async () => {
		await writeFile(join(root, "ADR.jsonl"), "");
		const saved = await writeDecisions(root, [decision], capturedAt);
		expect(await readFile(join(root, "ADR.jsonl"), "utf8")).toBe(`${JSON.stringify(saved[0])}\n`);
	});

	it("keeps concurrent cooperating writers' entire batches intact", async () => {
		const batches = await Promise.all(Array.from({ length: 12 }, (_, writer) => writeDecisions(root, [
			{ ...decision, decision: `${writer}:start ${"x".repeat(70_000)}` },
			{ ...decision, decision: `${writer}:end` },
		], capturedAt)));
		const rows = await readDecisions();
		expect(rows).toHaveLength(24);
		expect(new Set(rows.map((record) => record.id)).size).toBe(24);
		for (const batch of batches) {
			const start = rows.findIndex((row) => row.id === batch[0].id);
			expect(rows.slice(start, start + 2)).toEqual(batch);
		}
		expect(await readdir(root)).toEqual(["ADR.jsonl"]);
	});

	it("waits for another writer's lock and never removes it prematurely", async () => {
		const lock = join(root, "ADR.jsonl.lock");
		await writeFile(lock, "other writer");
		const pending = writeDecisions(root, [decision], capturedAt);
		await new Promise((done) => setTimeout(done, 60));
		expect(await readFile(lock, "utf8")).toBe("other writer");
		expect(await readdir(root)).toEqual(["ADR.jsonl.lock"]);
		await unlink(lock);
		expect(await pending).toHaveLength(1);
	});

	it("discards stale output after waiting for the ADR lock", async () => {
		const lock = join(root, "ADR.jsonl.lock");
		const original = '{"id":"existing"}';
		await writeFile(join(root, "ADR.jsonl"), original);
		await writeFile(lock, "other writer");
		let active = true;
		const pending = writeDecisions(root, [decision], capturedAt, () => active);
		await new Promise((done) => setTimeout(done, 60));
		active = false;
		await unlink(lock);
		expect(await pending).toEqual([]);
		expect(await readFile(join(root, "ADR.jsonl"), "utf8")).toBe(original);
		expect(await readdir(root)).toEqual(["ADR.jsonl"]);
	});

	it("rechecks permission immediately before appending records or their separator", async () => {
		const original = '{"id":"existing"}';
		await writeFile(join(root, "ADR.jsonl"), original);
		const canWrite = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
		expect(await writeDecisions(root, [decision], capturedAt, canWrite)).toEqual([]);
		expect(canWrite).toHaveBeenCalledTimes(3);
		expect(await readFile(join(root, "ADR.jsonl"), "utf8")).toBe(original);
		expect(await readdir(root)).toEqual(["ADR.jsonl"]);
	});

	it("bounds lock contention instead of stealing an existing lock", async () => {
		await writeFile(join(root, "ADR.jsonl.lock"), "existing owner");
		await expect(writeDecisions(root, [decision], capturedAt)).rejects.toThrow("Timed out");
		expect(await readdir(root)).toEqual(["ADR.jsonl.lock"]);
		expect(await readFile(join(root, "ADR.jsonl.lock"), "utf8")).toBe("existing owner");
	});

	it.each([null, {}, [null], [{ ...decision, who: "human" }], [{ ...decision, files: "src/a.ts" }],
		[{ ...decision, files: [4] }], [{ ...decision, files: [] }], [{ ...decision, decision: "" }],
		[{ ...decision, decision: " \n\t" }], [{ ...decision, decision: 5 }], [{ ...decision, reason: null }]])(
		"rejects invalid structure %# before artifact creation", async (drafts) => {
			await expect(writeDecisions(root, drafts as DecisionDraft[], capturedAt)).rejects.toThrow("Invalid decision");
			expect(await readdir(root)).toEqual([]);
		},
	);

	it.each(["", " ", " \t", "/tmp/outside.ts", "../outside.ts", "src/../../outside.ts", "src/../a.ts", "./a.ts",
		"src//a.ts", "src/", "C:\\outside.ts", "C:/outside.ts", "C:outside.ts", "\\\\host\\share\\a.ts",
		"src\\a.ts", "src/evil\0.ts", "src/evil\n.ts"])("rejects unsafe file path %j", async (path) => {
		await expect(writeDecisions(root, [{ ...decision, files: ["safe.ts", path] }], capturedAt))
			.rejects.toThrow("file path");
		expect(await readdir(root)).toEqual([]);
	});

	it("accepts literal relative paths without requiring existing source files", async () => {
		const files = ["new/deep/file.ts", "src/a file.ts", "src/日本語.ts", "src/not-a-glob[1].ts"];
		expect((await writeDecisions(root, [{ ...decision, files }], capturedAt))[0].files).toEqual(files);
	});

	it("rejects symlink and hard-link ADR targets without modifying their destination", async () => {
		const outside = join(sandbox, "outside.jsonl");
		const target = join(root, "ADR.jsonl");
		await writeFile(outside, "untouched\n");
		await symlink(outside, target);
		await expect(writeDecisions(root, [decision], capturedAt)).rejects.toThrow();
		expect(await readFile(outside, "utf8")).toBe("untouched\n");
		expect(await readdir(root)).toEqual(["ADR.jsonl"]);

		await unlink(target);
		await link(outside, target);
		await expect(writeDecisions(root, [decision], capturedAt)).rejects.toThrow("unshared regular file");
		expect(await readFile(outside, "utf8")).toBe("untouched\n");
		expect(await readdir(root)).toEqual(["ADR.jsonl"]);
	});

	it("releases the writer lock after a filesystem error", async () => {
		await mkdir(join(root, "ADR.jsonl"));
		await expect(writeDecisions(root, [decision], capturedAt)).rejects.toThrow();
		expect(await readdir(root)).toEqual(["ADR.jsonl"]);
	});
});

describe("lesson persistence", () => {
	it("writes exactly three frontmatter fields and preserves a Markdown body", async () => {
		vi.stubEnv("TZ", "America/New_York");
		const paths = await writeLessons(root, [lesson], capturedAt);
		expect(paths).toEqual([join(root, "MEMORIES", "preserve-capture-time.frontmatter.md")]);
		expect(isAbsolute(paths[0])).toBe(true);
		expect(await readFile(paths[0], "utf8")).toBe('---\ndescription: "Preserve capture time"\n'
			+ 'datetime: 2026-07-20T09:14:15.123-04:00 # EDT\n'
			+ 'tags: [memory, capture-time]\n---\n\n' + lesson.body + "\n");
	});

	it.each([
		["2026-01-20T13:14:15Z", "2026-01-20T08:14:15.000-05:00 # EST"],
		["2026-07-20T13:14:15Z", "2026-07-20T09:14:15.000-04:00 # EDT"],
	])("derives the local offset and zone from capture date %s", async (instant, expected) => {
		vi.stubEnv("TZ", "America/New_York");
		const [path] = await writeLessons(root, [lesson], new Date(instant));
		expect(await readFile(path, "utf8")).toContain(`datetime: ${expected}\n`);
	});

	it("supports positive fractional-hour timezone offsets", async () => {
		vi.stubEnv("TZ", "Asia/Kathmandu");
		const [path] = await writeLessons(root, [lesson], capturedAt);
		expect(await readFile(path, "utf8")).toContain("datetime: 2026-07-20T18:59:15.123+05:45 # ");
	});

	it("serializes frontmatter injection strings as quoted values", async () => {
		const description = 'Quotes " slash \\ tab\t\n---\nextra: value 日本語';
		const [path] = await writeLessons(root, [{ ...lesson, description }], capturedAt);
		const lines = (await readFile(path, "utf8")).split("\n");
		expect(JSON.parse(lines[1].slice("description: ".length))).toBe(description);
		expect(lines[3]).toBe("tags: [memory, capture-time]");
		expect(lines[4]).toBe("---");
	});

	it("keeps filenames safe and bounded even for traversal descriptions and long titles", async () => {
		const descriptions = ["../../outside\\name", "/absolute/title", "...", "日本語", "é".repeat(500)];
		const paths = await writeLessons(root, descriptions.map((description) => ({ ...lesson, description })), capturedAt);
		for (const path of paths) {
			expect(relative(join(root, "MEMORIES"), path)).toBe(basename(path));
			expect(basename(path)).toMatch(/^[a-z0-9-]+\.frontmatter\.md$/);
			expect(Buffer.byteLength(basename(path))).toBeLessThan(255);
		}
		expect(await readdir(sandbox)).toEqual(["project"]);
	});

	it("disambiguates collisions without overwriting existing lessons or following file symlinks", async () => {
		const memories = join(root, "MEMORIES");
		await mkdir(memories);
		const outside = join(sandbox, "outside.md");
		await writeFile(outside, "do not overwrite");
		await symlink(outside, join(memories, "preserve-capture-time.frontmatter.md"));
		const paths = await writeLessons(root, [lesson, { ...lesson, body: "Different lesson" }], capturedAt);
		expect(new Set(paths).size).toBe(2);
		expect(paths.every((path) => basename(path).startsWith("preserve-capture-time-"))).toBe(true);
		expect(await readFile(outside, "utf8")).toBe("do not overwrite");
		expect(await readFile(paths[0], "utf8")).toContain(lesson.body);
		expect(await readFile(paths[1], "utf8")).toContain("Different lesson");
	});

	it("preserves an existing regular lesson on title collision", async () => {
		const [first] = await writeLessons(root, [lesson], capturedAt);
		const original = await readFile(first, "utf8");
		const [second] = await writeLessons(root, [{ ...lesson, body: "Second body" }], capturedAt);
		expect(second).not.toBe(first);
		expect(await readFile(first, "utf8")).toBe(original);
		expect(await readFile(second, "utf8")).toContain("Second body");
	});

	it("rechecks permission before lesson contents and removes the skipped empty file", async () => {
		const expected = join(root, "MEMORIES", "preserve-capture-time.frontmatter.md");
		const paths = await writeLessons(root, [lesson], capturedAt, () => !existsSync(expected));
		expect(paths).toEqual([]);
		expect(await readdir(join(root, "MEMORIES"))).toEqual([]);
	});

	it("returns only saved paths when permission changes between lessons", async () => {
		const first = join(root, "MEMORIES", "preserve-capture-time.frontmatter.md");
		const paths = await writeLessons(root, [lesson, { ...lesson, description: "Second lesson" }], capturedAt,
			() => !existsSync(first) || statSync(first).size === 0);
		expect(paths).toEqual([first]);
		expect(await readdir(join(root, "MEMORIES"))).toEqual([basename(first)]);
		expect(await readFile(first, "utf8")).toContain(lesson.body);
	});

	it("creates lessons exclusively under concurrent title collisions", async () => {
		const saved = await Promise.all(Array.from({ length: 16 }, (_, index) => writeLessons(root,
			[{ ...lesson, body: `Writer ${index}` }], capturedAt)));
		const paths = saved.flat();
		expect(new Set(paths).size).toBe(16);
		expect(await readdir(join(root, "MEMORIES"))).toHaveLength(16);
		for (const [index, path] of paths.entries()) {
			expect(await readFile(path, "utf8")).toContain(`\nWriter ${index}\n`);
		}
	});

	it.each([null, {}, [null], [{ ...lesson, description: 4 }], [{ ...lesson, tags: "memory" }],
		[{ ...lesson, tags: [false] }], [{ ...lesson, description: "" }], [{ ...lesson, description: " \t" }],
		[{ ...lesson, body: "" }], [{ ...lesson, body: " \n" }], [{ ...lesson, tags: [] }],
		[{ ...lesson, tags: [""] }], [{ ...lesson, tags: ["Uppercase"] }], [{ ...lesson, tags: ["with spaces"] }],
		[{ ...lesson, tags: ["under_score"] }], [{ ...lesson, tags: ["unsafe\n---"] }], [{ ...lesson, tags: ["memory\n"] }],
		[{ ...lesson, tags: ["a: b"] }], [{ ...lesson, tags: ['quoted"value'] }],
		[{ ...lesson, tags: ["-leading"] }], [{ ...lesson, tags: ["trailing-"] }],
		[{ ...lesson, body: null }]])("rejects invalid lesson structure %#", async (drafts) => {
		await expect(writeLessons(root, drafts as LessonDraft[], capturedAt)).rejects.toThrow("Invalid lesson");
		expect(await readdir(root)).toEqual([]);
	});

	it("rejects a MEMORIES symlink without writing outside the project", async () => {
		const outside = join(sandbox, "outside");
		await mkdir(outside);
		await symlink(outside, join(root, "MEMORIES"));
		await expect(writeLessons(root, [lesson], capturedAt)).rejects.toThrow("not a symlink");
		expect(await readdir(outside)).toEqual([]);
	});

	it("rejects a non-directory MEMORIES target", async () => {
		await writeFile(join(root, "MEMORIES"), "unchanged");
		await expect(writeLessons(root, [lesson], capturedAt)).rejects.toThrow("directory");
		expect(await readFile(join(root, "MEMORIES"), "utf8")).toBe("unchanged");
	});
});

describe("shared draft contract", () => {
	it("exports wire constants and guards usable on stored records without validating generated metadata", () => {
		expect(ATTRIBUTIONS).toEqual(["user", "agent+user", "agent"]);
		expect(new RegExp(LESSON_TAG_PATTERN).test("capture-time")).toBe(true);
		expect(isDecisionDraft({ ...decision, id: "generated", date: capturedAt.toISOString() })).toBe(true);
		expect(isLessonDraft({ ...lesson, datetime: capturedAt.toISOString() })).toBe(true);
		expect(isDecisionDraft(null)).toBe(false);
		expect(isLessonDraft(null)).toBe(false);
	});
});

describe("persistence boundaries", () => {
	it("does nothing for empty batches", async () => {
		expect(await writeDecisions(root, [], capturedAt)).toEqual([]);
		expect(await writeLessons(root, [], capturedAt)).toEqual([]);
		expect(await readdir(root)).toEqual([]);
	});

	it("skips disabled writes without creating artifacts", async () => {
		expect(await writeDecisions(root, [decision], capturedAt, () => false)).toEqual([]);
		expect(await writeLessons(root, [lesson], capturedAt, () => false)).toEqual([]);
		expect(await readdir(root)).toEqual([]);
	});

	it("rejects sparse arrays instead of serializing missing records or null paths", async () => {
		await expect(writeDecisions(root, Array(1), capturedAt)).rejects.toThrow("Invalid decision");
		await expect(writeDecisions(root, [{ ...decision, files: Array(1) }], capturedAt)).rejects.toThrow("Invalid decision");
		await expect(writeLessons(root, Array(1), capturedAt)).rejects.toThrow("Invalid lesson");
		await expect(writeLessons(root, [{ ...lesson, tags: Array(1) }], capturedAt)).rejects.toThrow("Invalid lesson");
		expect(await readdir(root)).toEqual([]);
	});

	it("validates entire batches before any writes", async () => {
		await expect(writeDecisions(root, [decision, { ...decision, files: ["../escape"] }], capturedAt)).rejects.toThrow();
		await expect(writeLessons(root, [lesson, { ...lesson, body: 3 } as unknown as LessonDraft], capturedAt)).rejects.toThrow();
		expect(await readdir(root)).toEqual([]);
	});

	it("rejects invalid dates before creating artifacts", async () => {
		await expect(writeDecisions(root, [decision], new Date("invalid"))).rejects.toThrow("capture date");
		await expect(writeLessons(root, [lesson], new Date("invalid"))).rejects.toThrow("capture date");
		expect(await readdir(root)).toEqual([]);
	});

	it.each(["", ".", "../project", "bad\0root"])("rejects unsafe project root %j", async (path) => {
		await expect(writeDecisions(path, [decision], capturedAt)).rejects.toThrow("absolute directory");
		await expect(writeLessons(path, [lesson], capturedAt)).rejects.toThrow("absolute directory");
	});

	it("rejects nonexistent and non-directory project roots without creating them", async () => {
		const missing = join(root, "missing");
		await expect(writeDecisions(missing, [decision], capturedAt)).rejects.toThrow();
		await expect(writeLessons(missing, [lesson], capturedAt)).rejects.toThrow();
		const file = join(root, "file");
		await writeFile(file, "not a directory");
		await expect(writeDecisions(file, [decision], capturedAt)).rejects.toThrow("directory");
		await expect(writeLessons(file, [lesson], capturedAt)).rejects.toThrow("directory");
		expect(await readdir(root)).toEqual(["file"]);
	});
});
