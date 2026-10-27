import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerDurableMemory } from "./durable-memory/index.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { maybeTriggerCompaction, registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { Runtime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();
	const prepareReflector = registerDurableMemory(pi);

	registerConsolidationTrigger(pi, runtime, {
		prepareReflector,
		afterIdleConsolidation: (ctx) => maybeTriggerCompaction(runtime, ctx as Parameters<typeof maybeTriggerCompaction>[1]),
	});
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerRecallTool(pi);
}
