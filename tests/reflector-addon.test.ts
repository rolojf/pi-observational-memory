import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ReflectorStreamError, runReflector, type ReflectorAddon } from "../src/agents/reflector/agent.js";
import { REFLECTOR_SYSTEM } from "../src/agents/reflector/prompts.js";
import { observation } from "./fixtures/session.js";

const baseArgs = {
	model: {} as any,
	apiKey: "test",
	reflections: [],
	observations: [observation("aaaaaaaaaaaa")],
};

function fakeLoop(
	handler: (context: any, config: any) => Promise<void> | void,
	options: { stopReason?: string; iteratorError?: Error; resultError?: Error; result?: () => void } = {},
): any {
	return (_prompts: any, context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			await handler(context, config);
			if (options.iteratorError) throw options.iteratorError;
			if (options.stopReason) yield { type: "message_end", message: { role: "assistant", stopReason: options.stopReason } };
		},
		result: async () => {
			if (options.resultError) throw options.resultError;
			options.result?.();
			return [];
		},
	});
}

function makeAddon() {
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Buffered" }], details: {} }));
	const tool: AgentTool<any> = {
		name: "record_exports",
		label: "Record exports",
		description: "Buffer additional outputs",
		parameters: Type.Object({}),
		execute,
	};
	const addon: ReflectorAddon = { systemPrompt: "Additional output instructions", tools: [tool], complete: vi.fn() };
	return { addon, execute };
}

async function record(context: any) {
	await context.tools[0].execute("reflection-1", {
		reflections: [{ content: "Stable project invariant", supportingObservationIds: ["aaaaaaaaaaaa"] }],
	});
}

describe("reflector addon", () => {
	it("keeps the disabled prompt, tools, and empty return unchanged", async () => {
		const loop = fakeLoop((context) => {
			expect(context.messages).toEqual([{ role: "system", content: REFLECTOR_SYSTEM, timestamp: expect.any(Number) }]);
			expect(context.tools.map((tool: any) => tool.name)).toEqual(["record_reflections"]);
		});

		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("appends instructions and tools in the same loop and completes after result resolution", async () => {
		const { addon, execute } = makeAddon();
		const order: string[] = [];
		vi.mocked(addon.complete).mockImplementation(() => { order.push("complete"); });
		const loop = vi.fn(fakeLoop(async (context) => {
			expect(context.messages[0].content).toBe(`${REFLECTOR_SYSTEM}\n\n${addon.systemPrompt}`);
			expect(context.tools.map((tool: any) => tool.name)).toEqual(["record_reflections", "record_exports"]);
			await context.tools[1].execute("export-1", {});
			await record(context);
			expect(addon.complete).not.toHaveBeenCalled();
		}, { result: () => { order.push("result"); } }));

		const reflections = await runReflector({ ...baseArgs, addon, agentLoop: loop });

		expect(reflections).toEqual([expect.objectContaining({ content: "Stable project invariant", supportingObservationIds: ["aaaaaaaaaaaa"] })]);
		expect(execute).toHaveBeenCalledOnce();
		expect(loop).toHaveBeenCalledOnce();
		expect(order).toEqual(["result", "complete"]);
	});

	it("completes an export-only run without manufacturing reflections", async () => {
		const { addon, execute } = makeAddon();
		const loop = fakeLoop(async (context) => { await context.tools[1].execute("export-1", {}); });

		await expect(runReflector({ ...baseArgs, addon, agentLoop: loop })).resolves.toBeUndefined();
		expect(execute).toHaveBeenCalledOnce();
		expect(addon.complete).toHaveBeenCalledOnce();
	});

	it("completes clean zero-output and turn-cap exits", async () => {
		const { addon } = makeAddon();
		const loop = fakeLoop((_context, config) => {
			expect(config.finishTurn({ message: { stopReason: "error" } })).toBeUndefined();
			expect(config.finishTurn({ message: { stopReason: "toolUse" } })).toEqual({ action: "end" });
		});

		await expect(runReflector({ ...baseArgs, addon, agentLoop: loop, maxTurns: 1 })).resolves.toBeUndefined();
		expect(addon.complete).toHaveBeenCalledOnce();
	});

	it("does not change reflection validation when enabled", async () => {
		const { addon } = makeAddon();
		const loop = fakeLoop(async (context) => {
			await context.tools[0].execute("invalid", { reflections: [
				{ content: "Unknown source", supportingObservationIds: ["bbbbbbbbbbbb"] },
				{ content: "Multiple\nlines", supportingObservationIds: ["aaaaaaaaaaaa"] },
			] });
		});

		await expect(runReflector({ ...baseArgs, addon, agentLoop: loop })).resolves.toBeUndefined();
		expect(addon.complete).toHaveBeenCalledOnce();
	});

	it.each(["error", "aborted"])("preserves partial reflections after an assistant %s without completing", async (stopReason) => {
		const { addon } = makeAddon();
		const loop = fakeLoop(record, { stopReason });

		const reflections = await runReflector({ ...baseArgs, addon, agentLoop: loop });

		expect(reflections).toHaveLength(1);
		expect(addon.complete).not.toHaveBeenCalled();
	});

	it.each(["error", "aborted"])("keeps empty assistant %s failures throwable without completing", async (stopReason) => {
		const { addon } = makeAddon();
		const loop = fakeLoop(() => {}, { stopReason });

		await expect(runReflector({ ...baseArgs, addon, agentLoop: loop })).rejects.toBeInstanceOf(ReflectorStreamError);
		expect(addon.complete).not.toHaveBeenCalled();
	});

	it.each(["iteratorError", "resultError"] as const)("does not complete after a %s, even with accepted reflections", async (failure) => {
		const { addon } = makeAddon();
		const error = new Error(failure);
		const loop = fakeLoop(record, { [failure]: error });

		await expect(runReflector({ ...baseArgs, addon, agentLoop: loop })).rejects.toBe(error);
		expect(addon.complete).not.toHaveBeenCalled();
	});

	it("does not complete if the signal aborts during result resolution", async () => {
		const { addon } = makeAddon();
		const controller = new AbortController();
		const loop = fakeLoop(record, { result: () => { controller.abort(); } });

		expect(await runReflector({ ...baseArgs, addon, agentLoop: loop, signal: controller.signal })).toHaveLength(1);
		expect(addon.complete).not.toHaveBeenCalled();
	});

	it("does not complete a pre-aborted or skipped run", async () => {
		const { addon } = makeAddon();
		const controller = new AbortController();
		controller.abort();
		const loop = vi.fn(fakeLoop(() => {}));

		await runReflector({ ...baseArgs, addon, agentLoop: loop, signal: controller.signal });
		await runReflector({ ...baseArgs, observations: [], addon, agentLoop: loop });

		expect(loop).toHaveBeenCalledOnce();
		expect(addon.complete).not.toHaveBeenCalled();
	});

	it("does not lose accepted reflections if completion throws", async () => {
		const { addon } = makeAddon();
		vi.mocked(addon.complete).mockImplementation(() => { throw new Error("completion failed"); });

		expect(await runReflector({ ...baseArgs, addon, agentLoop: fakeLoop(record) })).toHaveLength(1);
	});
});
