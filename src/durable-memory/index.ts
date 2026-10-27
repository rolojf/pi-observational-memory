import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConsolidationTriggerHooks } from "../hooks/consolidation-trigger.js";
import { createCapture } from "./capture.js";
import { loadMemoryConfig, type MemoryConfig } from "./config.js";
import { registerRetrieval } from "./retrieval.js";

type Prepare = NonNullable<ConsolidationTriggerHooks["prepareReflector"]>;
type CaptureCtx = Parameters<Prepare>[0];
type ScopeCtx = Pick<CaptureCtx, "cwd" | "sessionManager" | "hasUI" | "ui">;
type Origin = {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	manager: ScopeCtx["sessionManager"];
};
type Scope =
	| { kind: "cold" }
	| { kind: "closed" }
	| { kind: "active"; origin: Origin; seen: Set<string> };

function originOf(ctx: ScopeCtx): Origin {
	return {
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId?.(),
		sessionFile: ctx.sessionManager.getSessionFile?.(),
		manager: ctx.sessionManager,
	};
}

function sameOrigin(a: Origin, b: Origin): boolean {
	if (a.cwd !== b.cwd || a.sessionId !== b.sessionId || a.sessionFile !== b.sessionFile) return false;
	return a.sessionId !== undefined || a.sessionFile !== undefined || a.manager === b.manager;
}

function branchIds(ctx: ScopeCtx): string[] {
	const branch = ctx.sessionManager.getBranch();
	if (!Array.isArray(branch)) return [];
	return branch.flatMap((entry: unknown) => entry && typeof entry === "object"
		&& "id" in entry && typeof entry.id === "string" ? [entry.id] : []);
}

/** Own addon state outside Runtime so upstream session-memory behavior stays separate. */
export function registerDurableMemory(pi: ExtensionAPI): Prepare {
	let scope: Scope = { kind: "cold" };
	let generation = 0;
	const configs = new Map<string, MemoryConfig>();
	const reported = new Set<string>();

	const configFor = (cwd: string): MemoryConfig => {
		if (scope.kind === "closed") return { mode: "off" };
		let config = configs.get(cwd);
		if (!config) {
			config = loadMemoryConfig(cwd);
			configs.set(cwd, config);
		}
		return config;
	};

	const activate = (ctx: ScopeCtx, mode: "reset" | "continue") => {
		const origin = originOf(ctx);
		if (mode === "reset" || scope.kind !== "active" || !sameOrigin(scope.origin, origin)) {
			generation++;
			scope = { kind: "active", origin, seen: new Set() };
			configs.clear();
			reported.clear();
		}
		const config = configFor(ctx.cwd);
		if (config.mode === "off" && config.problem && !reported.has(config.problem)) {
			reported.add(config.problem);
			if (ctx.hasUI) ctx.ui?.notify(config.problem, "warning");
		}
	};

	const invalidate = () => {
		generation++;
		scope = { kind: "closed" };
		configs.clear();
		reported.clear();
	};

	pi.on("session_start", (_event, ctx) => activate(ctx, "reset"));
	pi.on("before_agent_start", (_event, ctx) => activate(ctx, "continue"));
	pi.on("session_before_switch", invalidate);
	pi.on("session_before_fork", invalidate);
	pi.on("session_before_tree", invalidate);
	pi.on("session_tree", (_event, ctx) => activate(ctx, "reset"));
	pi.on("session_shutdown", invalidate);
	registerRetrieval(pi, configFor, () => generation);

	return (ctx, signal) => {
		if (scope.kind === "cold") activate(ctx, "continue");
		if (scope.kind !== "active" || signal?.aborted || !sameOrigin(scope.origin, originOf(ctx))) return;

		const config = configFor(ctx.cwd);
		if (config.mode === "off") return;
		const anchor = branchIds(ctx).at(-1);
		if (!anchor) return;

		const owner = scope;
		const epoch = generation;
		const canWrite = () => {
			if (scope !== owner || epoch !== generation || signal?.aborted) return false;
			try {
				if (!sameOrigin(owner.origin, originOf(ctx))) return false;
				const manager = ctx.sessionManager as ScopeCtx["sessionManager"] & { getCwd?: () => string };
				const currentCwd = manager.getCwd?.();
				if (currentCwd !== undefined && resolve(currentCwd) !== resolve(owner.origin.cwd)) return false;
				// Ordinary append-only growth keeps the captured leaf as an ancestor.
				return branchIds(ctx).includes(anchor);
			} catch {
				return false;
			}
		};

		return createCapture(config.projectRoot, canWrite, owner.seen);
	};
}
