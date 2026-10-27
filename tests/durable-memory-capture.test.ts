import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReflectorStreamError, runReflector } from "../src/agents/reflector/agent.js";
import { REFLECTOR_SYSTEM } from "../src/agents/reflector/prompts.js";
import { createCapture } from "../src/durable-memory/capture.js";
import * as storage from "../src/durable-memory/storage.js";
import type { DecisionDraft, DecisionRecord, LessonDraft } from "../src/durable-memory/types.js";
import type { ReflectorPass } from "../src/hooks/consolidation-trigger.js";
import { observation } from "./fixtures/session.js";

const decision: DecisionDraft = {
	who: "agent+user",
	files: ["src/runtime.ts", "tests/runtime.test.ts"],
	decision: "Accept headers-only model authentication",
	reason: "OAuth providers may not return an API key.",
};
const lesson: LessonDraft = {
	description: "Test OAuth auth shapes",
	tags: ["auth", "testing"],
	body: "# OAuth auth\n\nTest both API keys and headers-only credentials.",
};

let root: string;
let seen: Set<string>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "om-durable-capture-"));
	seen = new Set();
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await rm(root, { recursive: true, force: true });
});

function tool(pass: ReflectorPass, name: string) {
	return pass.addon.tools.find((candidate) => candidate.name === name)!;
}

async function decisions(pass: ReflectorPass, drafts: DecisionDraft[] = [decision]) {
	return tool(pass, "record_decisions").execute("decisions", { decisions: drafts });
}

async function lessons(pass: ReflectorPass, drafts: LessonDraft[] = [lesson]) {
	return tool(pass, "record_lessons").execute("lessons", { lessons: drafts });
}

async function rows(): Promise<DecisionRecord[]> {
	return (await readFile(join(root, "ADR.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
}

async function lessonFiles() {
	return readdir(join(root, "MEMORIES"));
}

function fakeLoop(handler: (context: any) => Promise<void>, stopReason?: string): any {
	return (_prompts: any, context: any) => ({
		async *[Symbol.asyncIterator]() {
			await handler(context);
			if (stopReason) yield { type: "message_end", message: { role: "assistant", stopReason } };
		},
		result: async () => [],
	});
}

function run(pass: ReflectorPass, handler: (context: any) => Promise<void>, stopReason?: string) {
	return runReflector({
		model: {} as any,
		apiKey: "test",
		observations: [observation("aaaaaaaaaaaa")],
		reflections: [],
		addon: pass.addon,
		agentLoop: fakeLoop(handler, stopReason),
	});
}

describe("buffered capture boundary", () => {
	it("exposes typed tools without model-selected dates, IDs, or filenames", () => {
		const pass = createCapture(root, () => true, seen);
		expect(pass.addon.tools.map(({ name }) => name)).toEqual(["record_decisions", "record_lessons"]);
		const decisionFields = (tool(pass, "record_decisions").parameters as any).properties.decisions.items.properties;
		const lessonFields = (tool(pass, "record_lessons").parameters as any).properties.lessons.items.properties;
		expect(Object.keys(decisionFields).sort()).toEqual(["decision", "files", "reason", "who"]);
		expect(Object.keys(lessonFields).sort()).toEqual(["body", "description", "tags"]);
	});

	it("does not write or mark seen during tools or completion", async () => {
		const pass = createCapture(root, () => true, seen);
		expect((await decisions(pass)).details).toEqual({ buffered: 1, duplicates: 0, rejected: 0 });
		await lessons(pass);
		expect(await readdir(root)).toEqual([]);
		expect(seen.size).toBe(0);
		pass.addon.complete();
		expect(await readdir(root)).toEqual([]);
		expect(seen.size).toBe(0);

		await pass.flush();
		expect(await rows()).toHaveLength(1);
		expect(await lessonFiles()).toHaveLength(1);
		expect(seen.size).toBe(2);
	});

	it("discards an uncompleted attempt, even if completion arrives after flush", async () => {
		const pass = createCapture(root, () => true, seen);
		await decisions(pass);
		await lessons(pass);
		await pass.flush();
		pass.addon.complete();
		await pass.flush();
		expect(await readdir(root)).toEqual([]);
		expect(seen.size).toBe(0);
	});

	it("closes collection at completion and tolerates repeated completion", async () => {
		const pass = createCapture(root, () => true, seen);
		await decisions(pass);
		pass.addon.complete();
		pass.addon.complete();
		await expect(lessons(pass)).rejects.toThrow("closed");
		await pass.flush();
		await expect(decisions(pass)).rejects.toThrow("closed");
		expect(await rows()).toHaveLength(1);
	});

	it.each(["none", "decisions", "lessons", "both"])("releases a clean %s-only/export-only run without session reflections", async (outputs) => {
		const pass = createCapture(root, () => true, seen);
		await expect(run(pass, async () => {
			if (outputs === "decisions" || outputs === "both") await decisions(pass);
			if (outputs === "lessons" || outputs === "both") await lessons(pass);
		})).resolves.toBeUndefined();
		await pass.flush();
		expect(existsSync(join(root, "ADR.jsonl"))).toBe(outputs === "decisions" || outputs === "both");
		expect(existsSync(join(root, "MEMORIES"))).toBe(outputs === "lessons" || outputs === "both");
	});

	it("releases clean exports alongside unchanged session reflections", async () => {
		const pass = createCapture(root, () => true, seen);
		const result = await run(pass, async (context) => {
			await decisions(pass);
			await lessons(pass);
			await context.tools[0].execute("reflection", { reflections: [
				{ content: "Stable auth constraint", supportingObservationIds: ["aaaaaaaaaaaa"] },
			] });
		});
		await pass.flush();
		expect(result).toEqual([expect.objectContaining({ content: "Stable auth constraint", supportingObservationIds: ["aaaaaaaaaaaa"] })]);
		expect(await rows()).toHaveLength(1);
		expect(await lessonFiles()).toHaveLength(1);
	});

	it.each(["error", "aborted"])("does not release outputs after %s, despite valid partial reflections", async (stopReason) => {
		const pass = createCapture(root, () => true, seen);
		const result = await run(pass, async (context) => {
			await decisions(pass);
			await context.tools[0].execute("reflection", { reflections: [
				{ content: "Stable auth constraint", supportingObservationIds: ["aaaaaaaaaaaa"] },
			] });
		}, stopReason);
		expect(result).toHaveLength(1);
		await pass.flush();
		expect(await readdir(root)).toEqual([]);
		expect(seen.size).toBe(0);
	});

	it("discards failed exports and allows the fresh fallback attempt to release them", async () => {
		const primary = createCapture(root, () => true, seen);
		await expect(run(primary, async () => { await decisions(primary); }, "error")).rejects.toBeInstanceOf(ReflectorStreamError);
		await primary.flush();
		const fallback = createCapture(root, () => true, seen);
		await run(fallback, async () => { await decisions(fallback); });
		await fallback.flush();
		expect(await rows()).toHaveLength(1);
		expect(seen.size).toBe(1);
	});

	it("preserves all attributions, optional reasons, and literal paths without requiring source files", async () => {
		const pass = createCapture(root, () => true, seen);
		const files = ["new/deep/file.ts", "src/a file.ts", "src/日本語.ts", "src/not-a-glob[1].ts"];
		const drafts: DecisionDraft[] = [
			{ who: "user", files, decision: "Human decision" },
			{ who: "agent", files, decision: "Agent decision", reason: "" },
			{ ...decision, files },
		];
		expect((await decisions(pass, drafts)).details).toEqual({ buffered: 3, duplicates: 0, rejected: 0 });
		pass.addon.complete();
		await pass.flush();
		expect((await rows()).map(({ id, date, ...draft }) => draft)).toEqual(drafts);
	});

	it("snapshots drafts and generates one capture date in code", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-07-20T13:14:15.123Z"));
		const pass = createCapture(root, () => true, seen);
		const mutable = structuredClone(decision);
		await decisions(pass, [mutable]);
		await lessons(pass);
		mutable.decision = "Changed after buffering";
		mutable.files.push("private.txt");
		pass.addon.complete();
		await pass.flush();
		expect(await rows()).toEqual([expect.objectContaining({ ...decision, date: "2026-07-20T13:14:15.123Z" })]);
		const [file] = await lessonFiles();
		const text = await readFile(join(root, "MEMORIES", file), "utf8");
		const datetime = text.match(/^datetime: (\S+)/m)![1];
		expect(new Date(datetime).toISOString()).toBe("2026-07-20T13:14:15.123Z");
	});
});

describe("cheap exact-repeat suppression", () => {
	it("suppresses exact repeats across calls and field ordering within a pass", async () => {
		const pass = createCapture(root, () => true, seen);
		await decisions(pass, [decision, decision]);
		const reordered = { reason: decision.reason, decision: decision.decision, files: decision.files, who: decision.who };
		expect((await decisions(pass, [reordered])).details).toEqual({ buffered: 0, duplicates: 1, rejected: 0 });
		await lessons(pass, [lesson, lesson]);
		await lessons(pass);
		pass.addon.complete();
		await pass.flush();
		await pass.flush();
		expect(await rows()).toHaveLength(1);
		expect(await lessonFiles()).toHaveLength(1);
		expect(seen.size).toBe(2);
	});

	it("uses the caller's session seen set but does not scan historical records", async () => {
		await writeFile(join(root, "ADR.jsonl"), "malformed historical row\n");
		const first = createCapture(root, () => true, seen);
		await decisions(first);
		await lessons(first);
		first.addon.complete();
		await first.flush();
		const second = createCapture(root, () => true, seen);
		expect((await decisions(second)).details).toEqual({ buffered: 0, duplicates: 1, rejected: 0 });
		expect((await lessons(second)).details).toEqual({ buffered: 0, duplicates: 1, rejected: 0 });
		second.addon.complete();
		await second.flush();
		const nextSession = createCapture(root, () => true, new Set());
		await decisions(nextSession);
		nextSession.addon.complete();
		await nextSession.flush();
		expect((await readFile(join(root, "ADR.jsonl"), "utf8")).split("\n")).toHaveLength(4);
		expect(await lessonFiles()).toHaveLength(1);
	});

	it("rechecks seen at release when another pass has already written", async () => {
		const first = createCapture(root, () => true, seen);
		const second = createCapture(root, () => true, seen);
		await decisions(first);
		await decisions(second);
		first.addon.complete();
		second.addon.complete();
		await first.flush();
		await second.flush();
		expect(await rows()).toHaveLength(1);
	});

	it("does not collapse nonidentical decisions or lessons", async () => {
		const write = vi.spyOn(storage, "writeDecisions");
		const writeLesson = vi.spyOn(storage, "writeLessons");
		const pass = createCapture(root, () => true, seen);
		await decisions(pass, [decision, { ...decision, who: "user" }, { ...decision, reason: "Different rationale" },
			{ ...decision, files: [...decision.files].reverse() }]);
		await lessons(pass, [lesson, { ...lesson, body: `${lesson.body}\nMore detail.` }, { ...lesson, tags: ["auth"] }]);
		pass.addon.complete();
		await pass.flush();
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0][1]).toHaveLength(4);
		expect(writeLesson).toHaveBeenCalledTimes(3);
		expect(writeLesson.mock.calls.every(([, drafts]) => drafts.length === 1)).toBe(true);
		expect(await rows()).toHaveLength(4);
		expect(await lessonFiles()).toHaveLength(3);
		expect(seen.size).toBe(7);
	});

	it("consumes before awaiting persistence so concurrent flushes write once", async () => {
		const lock = join(root, "ADR.jsonl.lock");
		await writeFile(lock, "other writer");
		const pass = createCapture(root, () => true, seen);
		await decisions(pass);
		pass.addon.complete();
		const first = pass.flush();
		const second = pass.flush();
		await unlink(lock);
		await Promise.all([first, second]);
		await pass.flush();
		expect(await rows()).toHaveLength(1);
		expect(seen.size).toBe(1);
	});
});

describe("current-origin guard", () => {
	it("skips stale output and never marks it seen", async () => {
		const pass = createCapture(root, () => false, seen);
		await decisions(pass);
		await lessons(pass);
		pass.addon.complete();
		await pass.flush();
		expect(await readdir(root)).toEqual([]);
		expect(seen.size).toBe(0);
	});

	it("passes the guard through a queued ADR write and does not retry a consumed pass", async () => {
		const lock = join(root, "ADR.jsonl.lock");
		await writeFile(lock, "other writer");
		let active = true;
		const pass = createCapture(root, () => active, seen);
		await decisions(pass, [decision, { ...decision, decision: "Another decision" }]);
		await lessons(pass);
		pass.addon.complete();
		const pending = pass.flush();
		await new Promise((done) => setTimeout(done, 60));
		active = false;
		await unlink(lock);
		await pending;
		expect(await readdir(root)).toEqual([]);
		expect(seen.size).toBe(0);
		active = true;
		await pass.flush();
		expect(await readdir(root)).toEqual([]);
	});

	it("does not mark a lesson seen when storage cancels before writing its contents", async () => {
		const target = join(root, "MEMORIES", "test-oauth-auth-shapes.frontmatter.md");
		const pass = createCapture(root, () => !existsSync(target), seen);
		await lessons(pass);
		pass.addon.complete();
		await pass.flush();
		expect(await lessonFiles()).toEqual([]);
		expect(seen.size).toBe(0);
	});

	it("preserves successful markers if the guard becomes false between records", async () => {
		const adr = join(root, "ADR.jsonl");
		const pass = createCapture(root, () => !existsSync(adr) || statSync(adr).size === 0, seen);
		await decisions(pass);
		await lessons(pass);
		pass.addon.complete();
		await pass.flush();
		expect(seen.size).toBe(1);
		expect(await rows()).toHaveLength(1);
		expect(existsSync(join(root, "MEMORIES"))).toBe(false);
		const next = createCapture(root, () => true, seen);
		await decisions(next);
		await lessons(next);
		next.addon.complete();
		await next.flush();
		expect(await rows()).toHaveLength(1);
		expect(await lessonFiles()).toHaveLength(1);
		expect(seen.size).toBe(2);
	});
});

describe("isolated persistence failures", () => {
	it("attempts one decision batch under a stale lock while lessons still succeed", async () => {
		const lock = join(root, "ADR.jsonl.lock");
		await writeFile(lock, "other writer");
		const write = vi.spyOn(storage, "writeDecisions");
		const drafts: DecisionDraft[] = [decision, { ...decision, decision: "Keep another decision" }];
		const pass = createCapture(root, () => true, seen);
		await decisions(pass, drafts);
		await lessons(pass);
		pass.addon.complete();
		const failure = await pass.flush().catch((error) => error);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0][1]).toEqual(drafts);
		expect(failure).toBeInstanceOf(AggregateError);
		expect(failure.errors).toHaveLength(1);
		expect(failure.message).toContain("Timed out");
		expect(await readFile(lock, "utf8")).toBe("other writer");
		expect(existsSync(join(root, "ADR.jsonl"))).toBe(false);
		expect(await lessonFiles()).toHaveLength(1);
		expect(seen.size).toBe(1);
		await pass.flush();
		expect(write).toHaveBeenCalledTimes(1);

		await unlink(lock);
		const retry = createCapture(root, () => true, seen);
		expect((await decisions(retry, drafts)).details).toEqual({ buffered: 2, duplicates: 0, rejected: 0 });
		expect((await lessons(retry)).details).toEqual({ buffered: 0, duplicates: 1, rejected: 0 });
		retry.addon.complete();
		await retry.flush();
		expect(write).toHaveBeenCalledTimes(2);
		expect(await rows()).toHaveLength(2);
		expect(await lessonFiles()).toHaveLength(1);
		expect(seen.size).toBe(3);
	}, 10_000);

	it("rejects malformed draft shapes without losing valid siblings", async () => {
		const pass = createCapture(root, () => true, seen);
		expect((await decisions(pass, [{ ...decision, who: "invalid" } as any, decision])).details)
			.toEqual({ buffered: 1, duplicates: 0, rejected: 1 });
		expect((await lessons(pass, [{ ...lesson, tags: ["INVALID"] }, lesson])).details)
			.toEqual({ buffered: 1, duplicates: 0, rejected: 1 });
		pass.addon.complete();
		await pass.flush();
		expect(await rows()).toHaveLength(1);
		expect(await lessonFiles()).toHaveLength(1);
	});

	it.each([
		{ ...decision, decision: " \n\t" },
		{ ...decision, files: [] },
		{ ...decision, files: Array(1) },
		...["", " ", " \t", "/tmp/outside.ts", "../escape.ts", "src/../../escape.ts", "src/../a.ts", "./a.ts",
			"src//a.ts", "src/", "C:\\outside.ts", "C:/outside.ts", "C:outside.ts", "\\\\host\\share\\a.ts",
			"src\\a.ts", "src/evil\0.ts", "src/evil\n.ts"].map((path) => ({ ...decision, files: ["safe.ts", path] })),
	])("rejects invalid decision %# while collecting without losing valid siblings", async (invalid) => {
		const pass = createCapture(root, () => true, seen);
		expect((await decisions(pass, [invalid, decision])).details).toEqual({ buffered: 1, duplicates: 0, rejected: 1 });
		pass.addon.complete();
		await expect(pass.flush()).resolves.toBeUndefined();
		expect(await rows()).toEqual([expect.objectContaining(decision)]);
		expect(seen.size).toBe(1);
	});

	it.each([
		{ ...lesson, description: " \t" },
		{ ...lesson, body: " \n" },
		{ ...lesson, tags: [] },
		{ ...lesson, tags: Array(1) },
		...["", "Uppercase", "with spaces", "under_score", "unsafe\n---", "auth\n", "-leading", "trailing-"]
			.map((tag) => ({ ...lesson, tags: [tag] })),
	])("rejects invalid lesson %# while collecting without losing valid siblings", async (invalid) => {
		const pass = createCapture(root, () => true, seen);
		expect((await lessons(pass, [invalid, lesson])).details).toEqual({ buffered: 1, duplicates: 0, rejected: 1 });
		pass.addon.complete();
		await expect(pass.flush()).resolves.toBeUndefined();
		expect(await lessonFiles()).toHaveLength(1);
		expect(seen.size).toBe(1);
	});

	it.each(["decisions", "lessons"])("preserves independent writes and markers when the %s filesystem target fails", async (failed) => {
		if (failed === "decisions") await mkdir(join(root, "ADR.jsonl"));
		else await writeFile(join(root, "MEMORIES"), "not a directory");
		const pass = createCapture(root, () => true, seen);
		await decisions(pass);
		await lessons(pass);
		pass.addon.complete();
		await expect(pass.flush()).rejects.toThrow(AggregateError);
		expect(seen.size).toBe(1);
		if (failed === "decisions") expect(await lessonFiles()).toHaveLength(1);
		else expect(await rows()).toHaveLength(1);

		await rm(join(root, failed === "decisions" ? "ADR.jsonl" : "MEMORIES"), { recursive: true });
		const retry = createCapture(root, () => true, seen);
		await decisions(retry);
		await lessons(retry);
		retry.addon.complete();
		await retry.flush();
		expect(await rows()).toHaveLength(1);
		expect(await lessonFiles()).toHaveLength(1);
		expect(seen.size).toBe(2);
	});
});

it("scopes privacy and attribution guidance to exports without changing reflection instructions", async () => {
	const pass = createCapture(root, () => true, seen);
	expect(pass.addon.systemPrompt).toContain(`Project root for repository-relative file paths: ${JSON.stringify(root)}.`);
	expect(pass.addon.systemPrompt).toContain("These instructions apply only to durable exports");
	expect(pass.addon.systemPrompt).toContain("personal/private session information");
	expect(pass.addon.systemPrompt).toContain("leave those in session memory");
	expect(pass.addon.systemPrompt).toContain("Preserve that inferred attribution");
	expect(pass.addon.systemPrompt).toContain("do not require proof");
	expect(pass.addon.systemPrompt).toContain("Zero outputs, decisions only, lessons only, or both");
	expect(pass.addon.systemPrompt).toContain("retrieved records merely being repeated");
	expect(pass.addon.systemPrompt).toContain("does not provide reflection coverage");
	await run(pass, async (context) => {
		expect(context.messages[0].content).toBe(`${REFLECTOR_SYSTEM}\n\n${pass.addon.systemPrompt}`);
		expect(context.tools.map((candidate: any) => candidate.name)).toEqual(["record_reflections", "record_decisions", "record_lessons"]);
	});
});
