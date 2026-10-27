import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryConfig } from "../src/durable-memory/config.js";
import { registerRetrieval } from "../src/durable-memory/retrieval.js";
import type { DecisionRecord } from "../src/durable-memory/types.js";

const io = vi.hoisted(() => ({
	opens: [] as string[], streams: [] as string[],
	reads: [] as { path: string; length: number; position: number }[],
}));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			const path = String(args[0]);
			io.opens.push(path);
			const handle = await fs.open(...args);
			const read = handle.read.bind(handle);
			const stream = handle.createReadStream.bind(handle);
			handle.read = ((...params: unknown[]) => {
				io.reads.push({ path, length: params[2] as number, position: params[3] as number });
				return (read as (...params: unknown[]) => unknown)(...params);
			}) as typeof handle.read;
			handle.createReadStream = ((...params: Parameters<typeof stream>) => {
				io.streams.push(path);
				return stream(...params);
			}) as typeof handle.createReadStream;
			return handle;
		},
	};
});

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Lookup = ToolDefinition & { outputSchema?: unknown; annotations?: Record<string, boolean> };
let sandbox: string;
let root: string;
let shared: string;

function harness(config: MemoryConfig = { mode: "project", projectRoot: root }) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Lookup>();
	let active = ["read", "edit", "write"];
	let current = config;
	let epoch = 0;
	const ctx = {
		cwd: root, hasUI: true, ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
		registerTool: vi.fn((tool: Lookup) => { tools.set(tool.name, tool); active.push(tool.name); }),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI;
	registerRetrieval(pi, () => current, () => epoch);
	const emit = async (name: string, event = {}) => {
		// The integration owns these transitions; retrieval only consumes its epoch.
		if (["session_start", "session_shutdown", "session_tree", "session_before_switch", "session_before_fork", "session_before_tree"].includes(name)) epoch++;
		let result: any;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	const lookup = async (params: unknown) => {
		const tool = tools.get("memory_lookup");
		if (!tool) throw new Error("memory_lookup not registered");
		return tool.execute("lookup", params, undefined, undefined, ctx);
	};
	return { pi, ctx, tools, handlers, emit, lookup, active: () => active,
		configure: (value: MemoryConfig) => { current = value; } };
}

function record(id = "one", extra: Partial<DecisionRecord> = {}): DecisionRecord {
	return { id, date: "2026-07-20T13:14:15.123Z", who: "user", files: ["src/target.ts"],
		decision: "Keep the intentional boundary", reason: "It preserves user intent", ...extra };
}

async function adr(records: unknown[]): Promise<void> {
	await writeFile(join(root, "ADR.jsonl"), records.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function result(path = "src/target.ts", extra: Record<string, unknown> = {}) {
	return { type: "tool_result", toolCallId: "read-1", toolName: "read", input: { path },
		content: [{ type: "text", text: "original content" }], details: { truncation: { marker: "preserve" } },
		isError: false, ...extra };
}

function output(value: any): string {
	return value.content.map((block: any) => block.text ?? "").join("\n");
}

async function query(h: ReturnType<typeof harness>, path = "src/target.ts") {
	return JSON.parse(output(await h.lookup({ action: "decisions", path })));
}

async function lesson(dir = join(root, "MEMORIES"), name = "boundary.frontmatter.md", body = "selected body") {
	await mkdir(dir, { recursive: true });
	const header = '---\ndescription: "Keep a boundary: even with quotes \\" and Unicode 日本語"\n'
		+ 'datetime: 2026-07-20T09:14:15-04:00 # EDT\ntags: [boundary, read-only]\n---\n';
	await writeFile(join(dir, name), header + body);
	return { header, path: join(dir, name), name };
}

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "om-durable-retrieval-"));
	root = join(sandbox, "project");
	shared = join(sandbox, "shared");
	await mkdir(root);
	io.opens.length = 0;
	io.streams.length = 0;
	io.reads.length = 0;
});

afterEach(async () => {
	await rm(sandbox, { recursive: true, force: true });
});

describe("decision lookup", () => {
	it("applies the shared stored-decision contract to historical rows", async () => {
		await adr([record("blank", { decision: " \t" }), record("empty", { files: [] }), record("valid")]);
		const h = harness();
		await h.emit("session_start");
		const found = await query(h);
		expect(found.records.map((row: DecisionRecord) => row.id)).toEqual(["valid"]);
		expect(found.diagnostic).toContain("2 malformed");
	});

	it("declares a root object schema while retaining action-specific arguments", async () => {
		const h = harness();
		await h.emit("session_start");
		const schema = h.tools.get("memory_lookup")!.parameters;
		expect(schema.type).toBe("object");
		expect(schema.anyOf).toBeUndefined();
		expect(schema.oneOf).toBeUndefined();
		expect(schema.required).toEqual(["action"]);
		expect(Object.keys(schema.properties).sort()).toEqual(["action", "file", "path", "query", "scope"]);
	});

	it("validates required action arguments before any memory-file reads", async () => {
		const h = harness();
		await h.emit("session_start");
		for (const params of [
			{ action: "decisions" }, { action: "decisions", path: 42 },
			{ action: "lesson", file: "boundary.frontmatter.md" },
			{ action: "lesson", scope: "project" },
			{ action: "lesson", scope: "other", file: "boundary.frontmatter.md" },
			{ action: "lessons", query: 42 }, { action: "unknown" },
		]) {
			expect(output(await h.lookup(params))).toContain("Invalid memory_lookup arguments");
		}
		expect(io.opens).toEqual([]);
	});

	it("matches normalized literal paths and absolute in-root paths, not near misses or globs", async () => {
		await adr([record("one", { files: ["src/target.ts", "test/target.ts"] }), record("two")]);
		const h = harness();
		await h.emit("session_start");
		for (const path of ["src/target.ts", "./src//target.ts", join(root, "src/target.ts")]) {
			expect((await query(h, path)).records.map((row: any) => row.id)).toEqual(["two", "one"]);
		}
		expect((await query(h, "test/target.ts")).records).toHaveLength(1);
		for (const path of ["src/targets.ts", "src/Target.ts", "target.ts", "src/*", "src/target.tsx"]) {
			expect((await query(h, path)).records).toEqual([]);
			expect(await h.emit("tool_result", result(path))).toBeUndefined();
		}
	});

	it("rejects traversal, foreign absolute paths and out-of-root requests before reading history", async () => {
		const h = harness();
		await h.emit("session_start");
		for (const path of ["../other.ts", "src/../target.ts", join(sandbox, "elsewhere.ts"), "C:\\outside.ts", "src\\target.ts", "\u0000"]) {
			expect(output(await h.lookup({ action: "decisions", path }))).toContain("Memory lookup unavailable");
		}
		expect(io.opens).toEqual([]);
	});

	it("keeps bounded append-order history with dates, attribution and omitted counts, not supersession", async () => {
		await adr(Array.from({ length: 25 }, (_, i) => record(String(i), {
			date: i === 24 ? "2000-01-01T00:00:00Z" : "2026-07-20T13:14:15.123Z",
			who: i % 2 ? "agent+user" : "agent", decision: "x".repeat(10_000), reason: "y".repeat(10_000),
		})));
		const h = harness();
		await h.emit("session_start");
		const found = await query(h);
		expect(found.records.length).toBeGreaterThan(0);
		expect(found.records.length).toBeLessThanOrEqual(8);
		expect(found.omitted + found.records.length).toBe(25);
		expect(found.records[0]).toMatchObject({ id: "24", who: "agent", date: "2000-01-01T00:00:00Z" });
		expect(JSON.stringify(found).length).toBeLessThan(13_000);
		expect(found.records[0].decision).toContain("truncated");
	});

	it("skips malformed/oversized rows and preserves ordinary escaped JSON data", async () => {
		const escaped = 'quotes " slash \\ tab\t newline\nUnicode 日本語 😀';
		await adr([record("good", { decision: escaped, reason: escaped }), { id: "broken" },
			record("wrong-who", { who: "stranger" as any }), record("escape", { files: ["../elsewhere"] })]);
		await appendFile(join(root, "ADR.jsonl"), "not json\n" + "x".repeat(300_000) + "\n" + JSON.stringify(record("last")));
		const h = harness();
		await h.emit("session_start");
		const found = await query(h);
		expect(found.records.map((row: any) => row.id)).toEqual(["last", "good"]);
		expect(found.records[1]).toMatchObject({ decision: escaped, reason: escaped });
		expect(found.diagnostic).toContain("5 malformed/oversized");
		await h.emit("tool_result", result());
		await h.emit("tool_result", result());
		expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("reuses the revision cache, reloads changed files, and resets on session/tree/root changes", async () => {
		await adr([record()]);
		const h = harness();
		await h.emit("session_start");
		await query(h);
		await query(h);
		expect(io.streams).toHaveLength(1);
		await appendFile(join(root, "ADR.jsonl"), JSON.stringify(record("two")) + "\n");
		expect((await query(h)).records).toHaveLength(2);
		expect(io.streams).toHaveLength(2);
		for (const event of ["session_tree", "session_shutdown", "session_start"]) {
			await h.emit(event);
			await query(h);
		}
		expect(io.streams).toHaveLength(5);
		const second = join(sandbox, "second");
		await mkdir(second);
		await writeFile(join(second, "ADR.jsonl"), JSON.stringify(record("other")) + "\n");
		h.configure({ mode: "project", projectRoot: second });
		expect((await query(h)).records[0].id).toBe("other");
	});

	it("refuses an ADR symlink outside the project and fails open on normal reads", async () => {
		await writeFile(join(sandbox, "private.jsonl"), JSON.stringify(record("private")));
		await symlink(join(sandbox, "private.jsonl"), join(root, "ADR.jsonl"));
		const h = harness();
		await h.emit("session_start");
		expect(output(await h.lookup({ action: "decisions", path: "src/target.ts" }))).toContain("outside its configured root");
		expect(await h.emit("tool_result", result())).toBeUndefined();
		expect(io.opens).toEqual([]);
	});
});

describe("metadata-first lessons", () => {
	it("selects by metadata using bounded chunked read-ahead and loads only the requested body", async () => {
		const first = await lesson(undefined, undefined, "secret first body".repeat(3_000));
		const second = await lesson(undefined, "second.frontmatter.md", "secret second body");
		const h = harness();
		await h.emit("session_start");
		const listed = output(await h.lookup({ action: "lessons", query: "read-only" }));
		const parsed = JSON.parse(listed);
		expect(parsed.lessons).toHaveLength(2);
		expect(parsed.lessons[0].datetime).toBe("2026-07-20T09:14:15-04:00");
		expect(parsed.lessons[0].description).toContain('quotes " and Unicode 日本語');
		expect(listed).not.toContain("secret");
		for (const file of [first, second]) {
			const reads = io.reads.filter((read) => read.path === file.path);
			expect(reads.length).toBeLessThanOrEqual(Math.ceil(Buffer.byteLength(file.header) / 1_024));
			expect(reads.every((read) => read.length > 1 && read.length <= 1_024
				&& read.position < Buffer.byteLength(file.header))).toBe(true);
		}
		io.reads.length = 0;
		const selected = JSON.parse(output(await h.lookup({ action: "lesson", scope: "project", file: first.name })));
		expect(selected.body).toContain("secret first body");
		expect(selected.body.length).toBeLessThanOrEqual(12_000);
		expect(selected.truncated).toBe(true);
		expect(io.reads.every((read) => read.path === first.path)).toBe(true);
		const bodyRead = io.reads.find((read) => read.length > 1_024)!;
		expect(bodyRead.position).toBe(Buffer.byteLength(first.header));
	});

	it("searches filenames and tags, not bodies, and bounds metadata lists", async () => {
		await lesson(undefined, "filename-only.frontmatter.md", "not-a-metadata-match");
		for (let i = 0; i < 22; i++) await lesson(undefined, `lesson-${i}.frontmatter.md`);
		const h = harness();
		await h.emit("session_start");
		expect(JSON.parse(output(await h.lookup({ action: "lessons", query: "not-a-metadata-match" }))).lessons).toEqual([]);
		expect(JSON.parse(output(await h.lookup({ action: "lessons", query: "filename-only" }))).lessons).toHaveLength(1);
		const all = JSON.parse(output(await h.lookup({ action: "lessons" })));
		expect(all.lessons.length).toBeLessThanOrEqual(20);
		expect(all.lessons.length + all.omitted).toBe(23);
	});

	it("labels optional shared scope, reads it without writes, and refuses an unconfigured shared scope", async () => {
		await lesson();
		const selected = await lesson(shared, "shared.frontmatter.md", "shared body");
		const original = await readFile(selected.path, "utf8");
		const h = harness({ mode: "project", projectRoot: root, sharedRoot: shared });
		await h.emit("session_start");
		const all = JSON.parse(output(await h.lookup({ action: "lessons" })));
		expect(all.lessons.map((meta: any) => meta.scope)).toEqual(["project", "shared"]);
		expect(JSON.parse(output(await h.lookup({ action: "lesson", scope: "shared", file: selected.name }))).body).toBe("shared body");
		expect(await readFile(selected.path, "utf8")).toBe(original);
		expect(await readdir(shared)).toEqual([selected.name]);
		h.configure({ mode: "project", projectRoot: root });
		expect(output(await h.lookup({ action: "lesson", scope: "shared", file: selected.name }))).toContain("not configured");
	});

	it("rejects traversal, outside file and directory symlinks, and arbitrary absolute lesson paths", async () => {
		const external = await lesson(shared, "external.frontmatter.md", "private body");
		await mkdir(join(root, "MEMORIES"));
		await symlink(external.path, join(root, "MEMORIES", external.name));
		const h = harness();
		await h.emit("session_start");
		for (const file of ["../external.frontmatter.md", external.path, external.name, "folder/../external.frontmatter.md"]) {
			expect(output(await h.lookup({ action: "lesson", scope: "project", file }))).toContain("Memory lookup unavailable");
		}
		expect(JSON.parse(output(await h.lookup({ action: "lessons" }))).lessons).toEqual([]);
		const second = join(sandbox, "second-project");
		await mkdir(second);
		await symlink(shared, join(second, "MEMORIES"));
		h.configure({ mode: "project", projectRoot: second });
		expect(JSON.parse(output(await h.lookup({ action: "lessons" }))).lessons).toEqual([]);
		expect(output(await h.lookup({ action: "lesson", scope: "project", file: external.name }))).toContain("outside its configured root");
		expect(io.opens).not.toContain(external.path);
	});

	it("rejects a parent-directory symlink that escapes MEMORIES but stays inside the repository", async () => {
		await lesson();
		const outside = await lesson(join(root, "other-data"), "private.frontmatter.md", "not a lesson in scope");
		await symlink(join(root, "other-data"), join(root, "MEMORIES", "alias"));
		const h = harness();
		await h.emit("session_start");
		const selected = output(await h.lookup({ action: "lesson", scope: "project", file: `alias/${outside.name}` }));
		expect(selected).toContain("outside its configured root");
		expect(selected).not.toContain("not a lesson in scope");
		expect(io.opens).toEqual([]);
	});

	it("keeps chunk-boundary/CRLF headers separate from bodies, including delimiter-like body text", async () => {
		const dir = join(root, "MEMORIES");
		await mkdir(dir);
		const prefix = '---\r\ndescription: "';
		const description = "x".repeat(1_023 - Buffer.byteLength(prefix)) + "日本語";
		const header = `${prefix}${description}"\r\ndatetime: 2026-07-20T00:00:00Z\r\ntags: [chunked]\r\n---\r\n`;
		const body = '---\ndescription: "body-only-marker"\ntags: [body-only-marker]\n---\nselected body';
		const name = "chunked.frontmatter.md";
		await writeFile(join(dir, name), header + body);
		const h = harness();
		await h.emit("session_start");
		const listed = JSON.parse(output(await h.lookup({ action: "lessons", query: "chunked" })));
		expect(listed.lessons).toHaveLength(1);
		expect(JSON.stringify(listed)).not.toContain("body-only-marker");
		const reads = io.reads.filter((read) => read.path === join(dir, name));
		expect(reads.length).toBeLessThanOrEqual(Math.ceil(Buffer.byteLength(header) / 1_024));
		expect(reads.every((read) => read.length <= 1_024 && read.position < Buffer.byteLength(header))).toBe(true);
		expect(JSON.parse(output(await h.lookup({ action: "lessons", query: "body-only-marker" }))).lessons).toEqual([]);
		const selected = JSON.parse(output(await h.lookup({ action: "lesson", scope: "project", file: name })));
		expect(selected.body).toBe(body);
	});

	it.each([
		'description: "   "\ndatetime: 2026-07-20T00:00:00Z\ntags: [memory]',
		'description: "Valid"\ndatetime: 2026-07-20T00:00:00Z\ntags: []',
		'description: "Valid"\ndatetime: 2026-07-20T00:00:00Z\ntags: [UPPER]',
		'description: "Valid"\ndatetime: not-a-date\ntags: [memory]',
	])("uses the shared lesson metadata contract %#", async (header) => {
		await mkdir(join(root, "MEMORIES"));
		await writeFile(join(root, "MEMORIES", "invalid.frontmatter.md"), `---\n${header}\n---\nprivate body`);
		const h = harness();
		await h.emit("session_start");
		const listed = JSON.parse(output(await h.lookup({ action: "lessons" })));
		expect(listed.lessons).toEqual([]);
		expect(listed.diagnostic).toContain("1 unreadable or malformed");
	});

	it("skips malformed headers without exposing bodies and reports a bounded diagnostic", async () => {
		await lesson();
		await writeFile(join(root, "MEMORIES", "bad.frontmatter.md"), "---\ndescription: [oops\n---\nprivate body");
		await writeFile(join(root, "MEMORIES", "oversized.frontmatter.md"), "---\n" + "x".repeat(20_000));
		const h = harness();
		await h.emit("session_start");
		const all = JSON.parse(output(await h.lookup({ action: "lessons" })));
		expect(all.lessons).toHaveLength(1);
		expect(all.diagnostic).toContain("2 unreadable or malformed");
		expect(JSON.stringify(all)).not.toContain("private body");
	});
});

describe("read annotations and lifecycle", () => {
	it.each(["session_before_switch", "session_before_fork", "session_before_tree"])(
		"drops pending results when the shared owner invalidates on %s", async (event) => {
			await adr([record()]);
			const h = harness();
			await h.emit("session_start");
			const annotation = h.emit("tool_result", result());
			const lookup = h.lookup({ action: "decisions", path: "src/target.ts" });
			await h.emit(event);
			expect(await annotation).toBeUndefined();
			expect((await lookup).content).toEqual([]);
		},
	);

	it("preserves unrelated result fields through the actual installed Pi hook runner", async () => {
		await adr([record()]);
		const h = harness();
		await h.emit("session_start");
		type Args = ConstructorParameters<typeof ExtensionRunner>;
		const extension = { path: "retrieval-test", handlers: h.handlers } as Args[0][number];
		const runner = new ExtensionRunner([extension], createExtensionRuntime(), root, {} as Args[3], {} as Args[4]);
		const event = result(undefined, { usage: { totalTokens: 123 } }) as unknown as ToolResultEvent;
		const annotated = await runner.emitToolResult(event);
		expect(annotated?.content?.[0]).toBe(event.content[0]);
		expect(annotated?.content?.[1]).toMatchObject({ type: "text", text: expect.stringContaining("Keep the intentional boundary") });
		expect(annotated?.details).toBe(event.details);
		expect(annotated?.usage).toEqual({ totalTokens: 123 });
		expect(annotated?.isError).toBe(false);
	});

	it("preserves original content/details, appends history and also updates structured text/image notes", async () => {
		await adr([record()]);
		const h = harness();
		await h.emit("session_start");
		for (const structuredContent of ["original structured text", { type: "image", data: "base64", mimeType: "image/png", note: "original note" }]) {
			const event = result(undefined, { structuredContent, usage: { totalTokens: 123 } });
			const original = structuredClone(event);
			const annotated = await h.emit("tool_result", event);
			expect(annotated.content[0]).toBe(event.content[0]);
			expect(annotated.details).toBe(event.details);
			expect(annotated.content[1].text).toContain("Keep the intentional boundary");
			expect(annotated.content[1].text).toContain("dates are capture times");
			if (typeof structuredContent === "string") expect(annotated.structuredContent).toContain(structuredContent);
			else expect(annotated.structuredContent).toMatchObject({ ...structuredContent, note: expect.stringContaining("original note") });
			expect(JSON.stringify(annotated.structuredContent)).toContain("Keep the intentional boundary");
			expect(event).toEqual(original);
		}
	});

	it("keeps disabled/no-match/failed/unsupported paths quiet and never hooks edit/write execution", async () => {
		const h = harness({ mode: "off" });
		await h.emit("session_start");
		await h.emit("before_agent_start");
		expect(h.tools.size).toBe(0);
		expect(await h.emit("tool_result", result())).toBeUndefined();
		expect(io.opens).toEqual([]);
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
		h.configure({ mode: "project", projectRoot: root });
		await h.emit("before_agent_start");
		expect(h.tools.has("memory_lookup")).toBe(true);
		for (const event of [result(), result(undefined, { isError: true }), result(undefined, { toolName: "edit" }),
			result(undefined, { toolName: "write" }), result("../escape.ts"), result(undefined, { input: {} })]) {
			expect(await h.emit("tool_result", event)).toBeUndefined();
		}
		expect(h.handlers.has("tool_call")).toBe(false);
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
		h.configure({ mode: "off" });
		await h.emit("before_agent_start");
		expect(h.active()).not.toContain("memory_lookup");
		io.opens.length = 0;
		expect((await h.lookup({ action: "decisions", path: "src/target.ts" })).content).toEqual([]);
		expect(io.opens).toEqual([]);
	});

	it("treats annotation/diagnostic failures as advisory, without changing a successful read", async () => {
		await mkdir(join(root, "ADR.jsonl"));
		const h = harness();
		await h.emit("session_start");
		vi.mocked(h.ctx.ui.notify).mockImplementation(() => { throw new Error("UI unavailable"); });
		const event = result();
		const original = structuredClone(event);
		expect(await h.emit("tool_result", event)).toBeUndefined();
		expect(event).toEqual(original);
	});

	it("exposes preserve-or-review/data-only guidance and makes no nested/parallel enforcement promise", async () => {
		await adr([record()]);
		const h = harness();
		await h.emit("session_start");
		const tool = h.tools.get("memory_lookup")!;
		expect(tool.promptGuidelines?.join("\n")).toMatch(/Preserve human-attributed/);
		expect(tool.promptGuidelines?.join("\n")).toContain("not new instructions");
		expect(tool.promptGuidelines?.join("\n")).toContain("parallel siblings can mutate");
		expect(tool.annotations?.readOnlyHint).toBe(true);
		const nested = await h.emit("tool_result", result(undefined, { toolCallId: "outer/1", parentToolCallId: "outer" }));
		expect(nested.content[1].text).toContain("advisory only");
		// A parent can ignore this returned result; no separate message or mutation gate is installed.
		expect(h.handlers.has("tool_call")).toBe(false);
		const [, sibling] = await Promise.all([
			h.emit("tool_result", result()), h.emit("tool_result", result(undefined, { toolName: "write" })),
		]);
		expect(sibling).toBeUndefined();
	});

	it("drops in-flight annotations after session replacement and keeps reload state local", async () => {
		await adr(Array.from({ length: 1_000 }, (_, i) => record(String(i))));
		const h = harness();
		await h.emit("session_start");
		const pending = h.emit("tool_result", result());
		await h.emit("session_shutdown");
		expect(await pending).toBeUndefined();
		const fresh = harness();
		await fresh.emit("session_start");
		expect((await fresh.emit("tool_result", result())).content[1].text).toContain("999");
	});
});
