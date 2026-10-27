import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const mocks = vi.hoisted(() => ({
	config: vi.fn(),
	capture: vi.fn(),
	retrieval: vi.fn(),
}));
vi.mock("../src/durable-memory/config.js", () => ({ loadMemoryConfig: mocks.config }));
vi.mock("../src/durable-memory/capture.js", () => ({ createCapture: mocks.capture }));
vi.mock("../src/durable-memory/retrieval.js", () => ({ registerRetrieval: mocks.retrieval }));

import { registerDurableMemory } from "../src/durable-memory/index.js";

function fixture() {
	let sessionId = "session-one";
	let cwd = "/project";
	let branch = [{ id: "root" }, { id: "observations" }];
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		on: vi.fn((event: string, handler: (...args: any[]) => any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: vi.fn() },
		model: {},
		modelRegistry: {},
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => sessionId,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
			getCwd: () => cwd,
		},
	};
	const prepare = registerDurableMemory(pi);
	const emit = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler({}, ctx);
	};
	return {
		ctx, prepare, emit,
		append: () => branch.push({ id: "later" }),
		changeBranch: () => { branch = [{ id: "root" }, { id: "other" }]; },
		changeSession: () => { sessionId = "session-two"; },
		changeCwd: () => { cwd = "/other"; },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.config.mockReturnValue({ mode: "project", projectRoot: "/project" });
	mocks.capture.mockImplementation((_root, canWrite, seen) => ({
		addon: { systemPrompt: "", tools: [], complete: vi.fn() },
		flush: vi.fn(),
		canWrite, seen,
	}));
});

async function start(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
	f.emit("session_start");
	await f.prepare(f.ctx, signal);
	return mocks.capture.mock.results.at(-1)!.value as { canWrite: () => boolean; seen: Set<string> };
}

describe("durable memory lifecycle ownership", () => {
	it("keeps disabled mode free of captures and registers retrieval separately", async () => {
		mocks.config.mockReturnValue({ mode: "off" });
		const f = fixture();
		f.emit("session_start");
		expect(await f.prepare(f.ctx, undefined)).toBeUndefined();
		expect(mocks.capture).not.toHaveBeenCalled();
		expect(mocks.retrieval).toHaveBeenCalledOnce();
	});

	it("allows normal branch growth and keeps exact-repeat state across ordinary runs", async () => {
		const f = fixture();
		const first = await start(f);
		first.seen.add("saved");
		f.append();
		f.emit("before_agent_start");
		expect(first.canWrite()).toBe(true);
		await f.prepare(f.ctx, undefined);
		const second = mocks.capture.mock.results.at(-1)!.value;
		expect(second.seen).toBe(first.seen);
		expect(mocks.config).toHaveBeenCalledTimes(1);
	});

	it("invalidates an attempt when its captured branch ancestor disappears", async () => {
		const f = fixture();
		const pass = await start(f);
		f.changeBranch();
		expect(pass.canWrite()).toBe(false);
	});

	it("detects session replacement even without a lifecycle event", async () => {
		const f = fixture();
		const pass = await start(f);
		f.changeSession();
		expect(pass.canWrite()).toBe(false);
		expect(await f.prepare(f.ctx, undefined)).toBeUndefined();
	});

	it("detects a changed session working directory", async () => {
		const f = fixture();
		const pass = await start(f);
		f.changeCwd();
		expect(pass.canWrite()).toBe(false);
	});

	it.each(["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"])(
		"invalidates delayed writes on %s and rejects new passes until reactivated", async (event) => {
			const f = fixture();
			const pass = await start(f);
			const [, configFor, getEpoch] = mocks.retrieval.mock.calls[0];
			const epoch = getEpoch();
			f.emit(event);
			expect(getEpoch()).toBeGreaterThan(epoch);
			expect(configFor(f.ctx.cwd)).toEqual({ mode: "off" });
			expect(pass.canWrite()).toBe(false);
			expect(await f.prepare(f.ctx, undefined)).toBeUndefined();
			expect(mocks.capture).toHaveBeenCalledTimes(1);
		},
	);

	it("starts a fresh scope after tree navigation even if the old anchor remains", async () => {
		const f = fixture();
		const pass = await start(f);
		pass.seen.add("old-branch");
		f.emit("session_tree");
		expect(pass.canWrite()).toBe(false);
		await f.prepare(f.ctx, undefined);
		expect(mocks.capture.mock.results.at(-1)!.value.seen.size).toBe(0);
	});

	it("recovers after a canceled navigation on the next user run", async () => {
		const f = fixture();
		const pass = await start(f);
		f.emit("session_before_tree");
		f.emit("before_agent_start");
		expect(pass.canWrite()).toBe(false);
		expect(await f.prepare(f.ctx, undefined)).toBeDefined();
	});

	it("does not invalidate capture merely because compaction appended a branch entry", async () => {
		const f = fixture();
		const pass = await start(f);
		f.append();
		f.emit("session_compact");
		expect(pass.canWrite()).toBe(true);
	});

	it("checks the captured abort signal before creation and during release", async () => {
		const f = fixture();
		const controller = new AbortController();
		const pass = await start(f, controller.signal);
		controller.abort();
		expect(pass.canWrite()).toBe(false);
		expect(await f.prepare(f.ctx, controller.signal)).toBeUndefined();
	});

	it("reports a configuration problem once per scope", async () => {
		mocks.config.mockReturnValue({ mode: "off", problem: "Invalid durable memory root" });
		const f = fixture();
		f.emit("session_start");
		f.emit("before_agent_start");
		await f.prepare(f.ctx, undefined);
		expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("Invalid durable memory root", "warning");
	});
});
