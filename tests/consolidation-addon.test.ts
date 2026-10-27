import { Type } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({ runReflector: vi.fn(), runObserver: vi.fn(), runDropper: vi.fn() }));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

import {
	registerConsolidationTrigger,
	runConsolidationPipeline,
	type ConsolidationTriggerHooks,
	type ReflectorPass,
} from "../src/hooks/consolidation-trigger.js";
import { OM_OBSERVATIONS_DROPPED, OM_REFLECTIONS_RECORDED } from "../src/session-ledger/index.js";
import { observation, observationsRecordedEntry, reflection, textCustomMessage, type TestEntry } from "./fixtures/session.js";

const { runReflector: realRunReflector } = await vi.importActual<typeof import("../src/agents/reflector/agent.js")>("../src/agents/reflector/agent.js");
const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 20 });
const newReflection = reflection("ffffffffffff", [obs.id]);

beforeEach(() => {
	mockAgents.runObserver.mockReset().mockResolvedValue(undefined);
	mockAgents.runReflector.mockReset().mockResolvedValue(undefined);
	mockAgents.runDropper.mockReset().mockResolvedValue(undefined);
});

function setup(hooks: ConsolidationTriggerHooks = {}, options: { consolidateWhenIdle?: boolean } = {}) {
	let entries: TestEntry[] = [
		textCustomMessage("raw-1", "source text"),
		observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
	];
	const handlers: Record<string, (event: unknown, ctx: any) => void> = {};
	const pi = {
		on: vi.fn((event: string, handler: (event: unknown, ctx: any) => void) => { handlers[event] = handler; }),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries.push({ type: "custom", id: `append-${entries.length}`, parentId: null, timestamp: "2026-05-02T10:00:00.000Z", customType, data });
		}),
	};
	let work: (() => Promise<void>) | undefined;
	let settle: (() => void) | undefined;
	const runtime = {
		config: {
			observeAfterTokens: 999,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 10,
			observationsPoolTargetTokens: 5,
			agentMaxTurns: 9,
			agentMaxTokens: 32000,
			showWorkerNotifications: true,
			consolidateWhenIdle: options.consolidateWhenIdle ?? false,
		},
		consolidationInFlight: false,
		consolidationAbortController: new AbortController(),
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: {}, apiKey: "primary" })),
		resolveFallbackModel: vi.fn(async (): Promise<any> => ({ ok: true, model: {}, apiKey: "fallback" })),
		recordConsolidationStageError: vi.fn((_ctx, _phase, error) => String(error)),
		abortConsolidation: vi.fn(() => {
			runtime.consolidationAbortController.abort();
			return true;
		}),
		launchConsolidationTask: vi.fn((_ctx, launch: () => Promise<void>) => {
			work = launch;
			return new Promise<void>((resolve) => { settle = resolve; });
		}),
	};
	const ctx = {
		cwd: "/tmp/addon-project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: {},
		modelRegistry: {},
		sessionManager: { getBranch: () => entries, getSessionId: () => "origin-session" },
	};
	registerConsolidationTrigger(pi as any, runtime as any, hooks);
	return {
		pi, runtime, ctx,
		run: () => runConsolidationPipeline(pi as any, runtime as any, ctx, hooks),
		fire: (event: string) => handlers[event](undefined, ctx),
		runLaunched: async () => { await work?.(); settle?.(); await Promise.resolve(); },
		setEntries: (next: TestEntry[]) => { entries = next; },
	};
}

function makePass() {
	const buffered: string[] = [];
	const written: string[] = [];
	let complete = false;
	const pass: ReflectorPass = {
		addon: {
			systemPrompt: "Buffer exports independently from session reflections.",
			tools: [{
				name: "record_exports",
				label: "Record exports",
				description: "Buffer exports",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (_id, params: { value: string }) => {
					buffered.push(params.value);
					return { content: [{ type: "text", text: "Buffered" }], details: {} };
				},
			}],
			complete: vi.fn(() => { complete = true; }),
		},
		flush: vi.fn(async () => { if (complete) written.push(...buffered); }),
	};
	return { pass, buffered, written };
}

function useLoop(
	handler: (context: any) => Promise<void> | void,
	options: { stopReason?: string; result?: () => void } = {},
) {
	mockAgents.runReflector.mockImplementationOnce((args) => realRunReflector({
		...args,
		agentLoop: ((_prompts: any, context: any) => ({
			async *[Symbol.asyncIterator]() {
				await handler(context);
				if (options.stopReason) yield { type: "message_end", message: { role: "assistant", stopReason: options.stopReason } };
			},
			result: async () => { options.result?.(); return []; },
		})) as any,
	}));
}

async function exportValue(context: any, value: string) {
	await context.tools[1].execute("export", { value });
}

async function record(context: any) {
	await context.tools[0].execute("reflection", {
		reflections: [{ content: "Stable project invariant", supportingObservationIds: [obs.id] }],
	});
}

describe("consolidation reflector addon", () => {
	it("preserves the disabled reflection and dropper path without an addon", async () => {
		const { run, pi, runtime } = setup();
		mockAgents.runReflector.mockResolvedValueOnce([newReflection]);
		mockAgents.runDropper.mockResolvedValueOnce([obs.id]);

		await run();

		expect(mockAgents.runReflector.mock.calls[0][0]).not.toHaveProperty("addon");
		expect(pi.appendEntry.mock.calls.map(([type]) => type)).toEqual([OM_REFLECTIONS_RECORDED, OM_OBSERVATIONS_DROPPED]);
		expect(runtime.resolveFallbackModel).not.toHaveBeenCalled();
	});

	it("threads the hook from turn-end registration and releases exports before reflection append", async () => {
		const { pass, written } = makePass();
		const prepareReflector = vi.fn(() => pass);
		const harness = setup({ prepareReflector });
		useLoop(async (context) => { await exportValue(context, "selected"); await record(context); });
		mockAgents.runDropper.mockResolvedValueOnce([obs.id]);
		harness.pi.appendEntry.mockImplementation(() => { expect(written).toEqual(["selected"]); });

		harness.fire("turn_end");
		await harness.runLaunched();

		expect(prepareReflector).toHaveBeenCalledWith(expect.objectContaining({ cwd: harness.ctx.cwd, sessionManager: harness.ctx.sessionManager }), harness.runtime.consolidationAbortController.signal);
		expect(pass.addon.complete).toHaveBeenCalledOnce();
		expect(pass.flush).toHaveBeenCalledOnce();
		expect(mockAgents.runDropper).toHaveBeenCalledOnce();
		expect(harness.pi.appendEntry.mock.calls.map(([type]) => type)).toEqual([OM_REFLECTIONS_RECORDED, OM_OBSERVATIONS_DROPPED]);
	});

	it("threads the hook from agent-start registration", async () => {
		const { pass } = makePass();
		const prepareReflector = vi.fn(() => pass);
		const harness = setup({ prepareReflector });

		harness.fire("agent_start");
		await harness.runLaunched();

		expect(prepareReflector).toHaveBeenCalledOnce();
		expect(pass.flush).toHaveBeenCalledOnce();
	});

	it("flushes clean export-only output without advancing reflection coverage or unlocking the dropper", async () => {
		const { pass, written } = makePass();
		const harness = setup({ prepareReflector: () => pass });
		useLoop(async (context) => { await exportValue(context, "export-only"); });

		await harness.run();

		expect(written).toEqual(["export-only"]);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
	});

	it("creates a fresh pass for fallback and discards the failed attempt's buffer", async () => {
		const first = makePass();
		const second = makePass();
		const prepareReflector = vi.fn().mockReturnValueOnce(first.pass).mockReturnValueOnce(second.pass);
		const harness = setup({ prepareReflector });
		useLoop(async (context) => { await exportValue(context, "failed-primary"); }, { stopReason: "error" });
		useLoop(async (context) => { await exportValue(context, "selected-fallback"); await record(context); });

		await harness.run();

		expect(prepareReflector).toHaveBeenCalledTimes(2);
		expect(first.buffered).toEqual(["failed-primary"]);
		expect(first.pass.flush).not.toHaveBeenCalled();
		expect(first.pass.addon.complete).not.toHaveBeenCalled();
		expect(first.written).toEqual([]);
		expect(second.written).toEqual(["selected-fallback"]);
		expect(harness.runtime.resolveFallbackModel).toHaveBeenCalledOnce();
		expect(mockAgents.runReflector.mock.calls.map(([args]) => args.apiKey)).toEqual(["primary", "fallback"]);
		expect(harness.pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, expect.objectContaining({ coversUpToId: "raw-1" }));
	});

	it("does not flush either attempt when primary and fallback fail", async () => {
		const first = makePass();
		const second = makePass();
		const harness = setup({ prepareReflector: vi.fn().mockReturnValueOnce(first.pass).mockReturnValueOnce(second.pass) });
		for (const value of ["primary", "fallback"]) {
			useLoop(async (context) => { await exportValue(context, value); }, { stopReason: "error" });
		}

		await harness.run();

		expect(first.pass.flush).not.toHaveBeenCalled();
		expect(second.pass.flush).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(harness.runtime.recordConsolidationStageError).toHaveBeenCalledWith(harness.ctx, "reflector", expect.any(Error));
	});

	it("preserves partial stream-error reflections and dropper progression without releasing buffered exports", async () => {
		const { pass, buffered, written } = makePass();
		const harness = setup({ prepareReflector: () => pass });
		useLoop(async (context) => { await exportValue(context, "incomplete"); await record(context); }, { stopReason: "error" });
		mockAgents.runDropper.mockResolvedValueOnce([obs.id]);

		await harness.run();

		expect(buffered).toEqual(["incomplete"]);
		expect(pass.addon.complete).not.toHaveBeenCalled();
		expect(pass.flush).toHaveBeenCalledOnce();
		expect(written).toEqual([]);
		expect(harness.runtime.resolveFallbackModel).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry.mock.calls.map(([type]) => type)).toEqual([OM_REFLECTIONS_RECORDED, OM_OBSERVATIONS_DROPPED]);
	});

	it("does not flush or append after the signal aborts during the reflector", async () => {
		const { pass, written } = makePass();
		const harness = setup({ prepareReflector: () => pass });
		useLoop(async (context) => { await exportValue(context, "aborted"); await record(context); }, {
			result: () => { harness.runtime.consolidationAbortController.abort(); },
		});

		await harness.run();

		expect(pass.flush).not.toHaveBeenCalled();
		expect(written).toEqual([]);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(harness.runtime.resolveFallbackModel).not.toHaveBeenCalled();
	});

	it("checks abort again after asynchronous preparation and after release", async () => {
		const prepared = makePass();
		const beforeModel = setup({ prepareReflector: async (_ctx, signal) => {
			beforeModel.runtime.consolidationAbortController.abort();
			expect(signal?.aborted).toBe(true);
			return prepared.pass;
		} });

		await beforeModel.run();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(prepared.pass.flush).not.toHaveBeenCalled();
		const released = makePass();
		const beforeAppend = setup({ prepareReflector: () => released.pass });
		vi.mocked(released.pass.flush).mockImplementation(async () => { beforeAppend.runtime.consolidationAbortController.abort(); });
		mockAgents.runReflector.mockResolvedValueOnce([newReflection]);

		await beforeAppend.run();

		expect(beforeAppend.pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it.each(["sync", "async"])("isolates %s preparation failure from fallback, reflection append, and dropper progression", async (mode) => {
		const harness = setup({ prepareReflector: () => {
			if (mode === "async") return Promise.reject(new Error("prepare denied"));
			throw new Error("prepare denied");
		} });
		mockAgents.runReflector.mockResolvedValueOnce([newReflection]);
		mockAgents.runDropper.mockResolvedValueOnce([obs.id]);

		await harness.run();

		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
		expect(mockAgents.runReflector.mock.calls[0][0]).not.toHaveProperty("addon");
		expect(harness.runtime.resolveFallbackModel).not.toHaveBeenCalled();
		expect(harness.runtime.recordConsolidationStageError).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reflector addon preparation failed: prepare denied"), "warning");
		expect(harness.pi.appendEntry.mock.calls.map(([type]) => type)).toEqual([OM_REFLECTIONS_RECORDED, OM_OBSERVATIONS_DROPPED]);
	});

	it("isolates a write failure from fallback, reflections, dropper, and the idle compaction callback", async () => {
		const { pass } = makePass();
		vi.mocked(pass.flush).mockRejectedValueOnce(new Error("disk full"));
		const afterIdleConsolidation = vi.fn();
		const harness = setup({ prepareReflector: () => pass, afterIdleConsolidation }, { consolidateWhenIdle: true });
		useLoop(async (context) => { await exportValue(context, "valid"); await record(context); });
		mockAgents.runDropper.mockResolvedValueOnce([obs.id]);

		harness.fire("agent_settled");
		await harness.runLaunched();

		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
		expect(harness.runtime.resolveFallbackModel).not.toHaveBeenCalled();
		expect(harness.runtime.recordConsolidationStageError).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reflector addon release failed: disk full"), "warning");
		expect(harness.pi.appendEntry.mock.calls.map(([type]) => type)).toEqual([OM_REFLECTIONS_RECORDED, OM_OBSERVATIONS_DROPPED]);
		expect(afterIdleConsolidation).toHaveBeenCalledWith(harness.ctx);
	});

	it.each([
		{ phase: "preparation", hasUI: true },
		{ phase: "release", hasUI: true },
		{ phase: "preparation", hasUI: false },
		{ phase: "release", hasUI: false },
	])("keeps addon failure warnings independent of routine notifications: $phase, hasUI=$hasUI", async ({ phase, hasUI }) => {
		const { pass } = makePass();
		const harness = setup({ prepareReflector: () => {
			if (phase === "preparation") throw new Error("addon failed");
			return pass;
		} });
		if (phase === "release") vi.mocked(pass.flush).mockRejectedValueOnce(new Error("addon failed"));
		harness.runtime.config.showWorkerNotifications = false;
		harness.ctx.hasUI = hasUI;
		mockAgents.runReflector.mockResolvedValueOnce([newReflection]);

		await harness.run();

		if (hasUI) {
			expect(harness.ctx.ui.notify.mock.calls).toEqual([
				[`Observational memory: reflector addon ${phase} failed: addon failed`, "warning"],
			]);
		} else {
			expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
		}
		expect(harness.runtime.resolveFallbackModel).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, expect.objectContaining({ reflections: [newReflection] }));
	});

	it("does not prepare an addon when the reflector is not due or observations have no coverage", async () => {
		const prepareReflector = vi.fn();
		const harness = setup({ prepareReflector });
		harness.runtime.config.reflectAfterTokens = 999;
		await harness.run();
		harness.runtime.config.reflectAfterTokens = 1;
		harness.setEntries([textCustomMessage("raw-1", "source text")]);
		await harness.run();

		expect(prepareReflector).not.toHaveBeenCalled();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});

	it("keeps the idle completion callback when no work launches", () => {
		const prepareReflector = vi.fn();
		const afterIdleConsolidation = vi.fn();
		const harness = setup({ prepareReflector, afterIdleConsolidation }, { consolidateWhenIdle: true });
		harness.runtime.config.reflectAfterTokens = 999;

		harness.fire("agent_settled");

		expect(afterIdleConsolidation).toHaveBeenCalledWith(harness.ctx);
		expect(prepareReflector).not.toHaveBeenCalled();
	});
});
