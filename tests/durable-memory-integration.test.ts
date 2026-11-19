import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	getCurrentTools,
	type AssistantMessage,
	type Context,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import observationalMemory from "../src/index.js";
import { REFLECTOR_SYSTEM } from "../src/agents/reflector/prompts.js";
import { Runtime } from "../src/runtime.js";
import { fullProjection, OM_REFLECTIONS_RECORDED, type Entry } from "../src/session-ledger/index.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

const OBSERVATION_ID = "aaaaaaaaaaaa";
const TARGET_PATH = "src/target.ts";
const DECISION = {
	who: "user" as const,
	files: [TARGET_PATH],
	decision: "Keep retrieval advisory rather than gating edits.",
	reason: "Nested and parallel calls cannot guarantee an intervening model turn.",
};
const LESSON = {
	description: "Parallel tool calls do not guarantee sequential model reasoning",
	tags: ["tool-calls", "parallel"],
	body: "A sibling edit can run before a read annotation reaches the model.\n\nUse advisory history without claiming a universal pre-edit guarantee.",
};
const REFLECTION = "Preserve human-attributed history while keeping retrieval advisory.";
const MODEL: Model<"openai-completions"> = {
	id: "integration-model", name: "Integration model", provider: "integration",
	api: "openai-completions", baseUrl: "http://invalid.test", reasoning: false,
	input: ["text"], contextWindow: 128_000, maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

type Mode = "default" | "disabled";
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
let sandbox: string;
let root: string;

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "om-durable-integration-"));
	root = join(sandbox, "project");
	const agentDir = join(sandbox, "agent");
	await mkdir(join(root, ".pi"), { recursive: true });
	await mkdir(join(root, "src"));
	await mkdir(agentDir);
	await writeFile(join(agentDir, "settings.json"), "{}");
	await writeFile(join(root, TARGET_PATH), "export const advisory = true;\n");
	vi.stubEnv("GIT_CEILING_DIRECTORIES", sandbox);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OBSERVATIONAL_MEMORY_PASSIVE", "false");
	expect(getAgentDir()).toBe(agentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(sandbox, { recursive: true, force: true });
});

async function fixture(mode: Mode) {
	await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
		...(mode === "disabled" ? { "durable-memory": false } : {}),
		"observational-memory": { reflectAfterTokens: 1, showWorkerNotifications: false },
	}));

	// Observation coverage makes only the reflector due; keep observer/dropper real but idle.
	const entries: TestEntry[] = [
		rawMessage("source-1", `${DECISION.decision} ${DECISION.reason} ${LESSON.body}`),
		observationsRecordedEntry("observed-1", {
			observations: [observation(OBSERVATION_ID, {
				content: `${DECISION.decision} ${DECISION.reason} ${LESSON.body}`,
				sourceEntryIds: ["source-1"],
			})],
			coversUpToId: "source-1",
		}, { parentId: "source-1" }),
	];
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const requests: Context[] = [];
	const calls: ToolCall[] = [{
		type: "toolCall", id: "reflection-call", name: "record_reflections",
		arguments: { reflections: [{ content: REFLECTION, supportingObservationIds: [OBSERVATION_ID] }] },
	}];
	if (mode === "default") calls.push(
		{ type: "toolCall", id: "decision-call", name: "record_decisions", arguments: { decisions: [DECISION] } },
		{ type: "toolCall", id: "lesson-call", name: "record_lessons", arguments: { lessons: [LESSON] } },
	);

	// Replace only transport: the real agent loop validates and executes production output tools.
	const streamSimple = vi.fn((_model: unknown, context: Context) => {
		requests.push(structuredClone(context));
		expect(existsSync(join(root, "ADR.jsonl"))).toBe(false);
		expect(existsSync(join(root, "MEMORIES"))).toBe(false);
		const stopReason = requests.length === 1 ? "toolUse" : "stop";
		const message: AssistantMessage = {
			role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
			content: requests.length === 1 ? calls : [{ type: "text", text: "Done." }],
			stopReason, timestamp: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", reason: stopReason, message });
		return stream;
	});
	const ctx = {
		cwd: root, hasUI: true, ui: { notify: vi.fn() }, model: MODEL,
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "fake-integration-key" })),
			streamSimple,
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "integration-session",
			getSessionFile: () => join(sandbox, "session.jsonl"),
			getCwd: () => root,
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: vi.fn(),
		registerTool: vi.fn((tool: ToolDefinition) => { tools.set(tool.name, tool); }),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries.push({ type: "custom", id: `appended-${entries.length}`, parentId: entries.at(-1)!.id,
				timestamp: new Date().toISOString(), customType, data });
		}),
	} as unknown as ExtensionAPI;
	// Observe the real task promise so assertions wait for flush and all pipeline stages.
	const launch = vi.spyOn(Runtime.prototype, "launchConsolidationTask");
	observationalMemory(pi);
	const emit = async (name: string, event: unknown = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results.filter((result) => result !== undefined);
	};
	const lookup = async (params: unknown) => {
		const tool = tools.get("memory_lookup");
		if (!tool) throw new Error("memory_lookup not registered");
		const result = await tool.execute("lookup", params, undefined, undefined, ctx);
		return JSON.parse(result.content.map((block) => block.type === "text" ? block.text : "").join("\n"));
	};
	await emit("session_start");
	await emit("before_agent_start");
	await emit("agent_start");
	expect(launch).toHaveBeenCalledOnce();
	await launch.mock.results[0].value;
	return { entries, tools, requests, streamSimple, ctx, pi, launch, emit, lookup };
}

function checkReflection(f: Awaited<ReturnType<typeof fixture>>) {
	expect(f.streamSimple).toHaveBeenCalledTimes(2);
	const results = f.requests[1].messages.filter((message) => message.role === "toolResult");
	expect(results.every((result) => !result.isError)).toBe(true);
	expect(f.pi.appendEntry).toHaveBeenCalledExactlyOnceWith(OM_REFLECTIONS_RECORDED, {
		reflections: [{ id: expect.stringMatching(/^[a-f0-9]{12}$/), content: REFLECTION,
			supportingObservationIds: [OBSERVATION_ID], tokenCount: expect.any(Number) }],
		coversUpToId: "source-1",
	});
	const memory = fullProjection(f.entries as Entry[]);
	expect(memory.reflections).toHaveLength(1);
	expect(memory.reflections[0].content).toBe(REFLECTION);
	expect(memory.observations.map((item) => item.id)).toEqual([OBSERVATION_ID]);
	expect(f.ctx.ui.notify).not.toHaveBeenCalled();
}

describe("registered durable memory integration", () => {
	it("persists and retrieves decisions and lessons by default outside Git", async () => {
		const f = await fixture("default");
		checkReflection(f);
		expect(getCurrentTools(f.requests[0].messages).map((tool) => tool.name)).toEqual([
			"record_reflections", "record_decisions", "record_lessons",
		]);
		expect(f.requests[1].messages.filter((message) => message.role === "toolResult").map((result) => result.toolName))
			.toEqual(["record_reflections", "record_decisions", "record_lessons"]);

		const adrText = await readFile(join(root, "ADR.jsonl"), "utf8");
		expect(adrText.endsWith("\n")).toBe(true);
		expect(adrText.trim().split("\n")).toHaveLength(1);
		const decision = JSON.parse(adrText);
		expect(decision).toEqual({ ...DECISION, id: expect.any(String), date: expect.any(String) });
		expect(Number.isFinite(Date.parse(decision.date))).toBe(true);
		const files = await readdir(join(root, "MEMORIES"));
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/\.frontmatter\.md$/);
		const saved = await readFile(join(root, "MEMORIES", files[0]), "utf8");
		const parsed = parseFrontmatter<{ datetime: string; description: string; tags: string[] }>(saved);
		expect(Object.keys(parsed.frontmatter).sort()).toEqual(["datetime", "description", "tags"]);
		expect(parsed.frontmatter).toMatchObject({ description: LESSON.description, tags: LESSON.tags });
		expect(Date.parse(parsed.frontmatter.datetime)).toBe(Date.parse(decision.date));
		expect(parsed.body.trim()).toBe(LESSON.body);

		const history = await f.lookup({ action: "decisions", path: TARGET_PATH });
		const { files: _paths, ...retrieved } = decision;
		expect(history).toEqual({ path: TARGET_PATH, records: [retrieved], omitted: 0 });
		const metadata = await f.lookup({ action: "lessons", query: "parallel" });
		expect(metadata.lessons).toEqual([{ scope: "project", file: files[0], description: LESSON.description,
			datetime: parsed.frontmatter.datetime, tags: LESSON.tags }]);
		expect(JSON.stringify(metadata)).not.toContain(LESSON.body);
		const lesson = await f.lookup({ action: "lesson", scope: "project", file: metadata.lessons[0].file });
		expect(lesson.body.trim()).toBe(LESSON.body);
		expect(lesson.truncated).toBe(false);

		// Covered history must not launch a second reflector pass on the next lifecycle event.
		await f.emit("turn_end");
		expect(f.launch).toHaveBeenCalledOnce();
		expect(f.streamSimple).toHaveBeenCalledTimes(2);
	});

	it("keeps ordinary reflections without durable tools, artifacts, or lookup declarations when disabled", async () => {
		const f = await fixture("disabled");
		checkReflection(f);
		expect(getCurrentTools(f.requests[0].messages).map((tool) => tool.name)).toEqual(["record_reflections"]);
		const system = f.requests[0].messages.find((message) => message.role === "system");
		expect(system?.content).toBe(REFLECTOR_SYSTEM);
		expect([...f.tools.keys()]).toEqual(["recall"]);
		expect(existsSync(join(root, "ADR.jsonl"))).toBe(false);
		expect(existsSync(join(root, "MEMORIES"))).toBe(false);
		expect((await readdir(root)).sort()).toEqual([".pi", "src"]);
		await f.emit("turn_end");
		expect(f.launch).toHaveBeenCalledOnce();
	});
});
