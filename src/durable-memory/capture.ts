import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import type { ReflectorPass } from "../hooks/consolidation-trigger.js";
import { hashId } from "../ids.js";
import { writeDecisions, writeLessons } from "./storage.js";
import { ATTRIBUTIONS, LESSON_TAG_PATTERN, isDecisionDraft, isLessonDraft, type DecisionDraft, type LessonDraft } from "./types.js";

const CAPTURE_PROMPT = `Optional durable project outputs (additional to, not replacements for, session reflections):
The existing record_reflections instructions and supporting observation ID requirements remain unchanged. Exporting a decision or lesson does not provide reflection coverage or permission to discard session memory.

Use record_decisions for stable project decisions tied to literal repository-relative file paths. Preserve the decision and its rationale when known, not just a list of changed files. Infer who from the available observations: user for a human decision, agent+user for a joint decision, agent for an agent decision. Preserve that inferred attribution; do not require proof, human ratification, raw-source verification, or another model pass.
Use record_lessons for reusable technical lessons useful to future work on this project. Supply a concise description, lowercase hyphenated tags, and a Markdown body; code generates filenames, IDs, and capture dates. A capture date is not the exact original decision time.

These instructions apply only to durable exports. Committed project files must not include personal/private session information, secrets, or unrelated user details; leave those in session memory, not in either export tool. Do not inspect other projects or promote lessons to shared memory.
Skip routine activity, transient work, and retrieved records merely being repeated as new discoveries. Select only what is useful and stable from the supplied context; do not scan historical files, reconcile statuses, or infer supersession.
Zero outputs, decisions only, lessons only, or both are all valid, independently of whether you emit session reflections. Tools only buffer drafts; code releases them after clean completion and a current-origin check.`;

const DecisionSchema = Type.Object({
	who: Type.Union(ATTRIBUTIONS.map((who) => Type.Literal(who))),
	files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	decision: Type.String({ minLength: 1 }),
	reason: Type.Optional(Type.String()),
}, { additionalProperties: false });

const LessonSchema = Type.Object({
	description: Type.String({ minLength: 1 }),
	tags: Type.Array(Type.String({ pattern: LESSON_TAG_PATTERN }), { minItems: 1 }),
	body: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const DecisionsSchema = Type.Object({ decisions: Type.Array(DecisionSchema, { minItems: 1 }) });
const LessonsSchema = Type.Object({ lessons: Type.Array(LessonSchema, { minItems: 1 }) });

type Output = { kind: "decision"; draft: DecisionDraft } | { kind: "lesson"; draft: LessonDraft };
type CaptureState =
	| { phase: "collecting" | "ready"; drafts: Map<string, Output> }
	| { phase: "consumed" };

function fingerprint(output: Output): string {
	// Fixed field order ignores object construction order, but preserves content and array order.
	const fields = output.kind === "decision"
		? [output.kind, output.draft.who, output.draft.files, output.draft.decision, output.draft.reason]
		: [output.kind, output.draft.description, output.draft.tags, output.draft.body];
	return hashId(JSON.stringify(fields));
}

export function createCapture(projectRoot: string, canWrite: () => boolean, seen: Set<string>): ReflectorPass {
	let state: CaptureState = { phase: "collecting", drafts: new Map() };

	function collect(kind: Output["kind"], proposals: unknown[]) {
		if (state.phase !== "collecting") throw new Error("Durable memory capture is closed");

		let buffered = 0;
		let duplicates = 0;
		let rejected = 0;
		for (const proposal of proposals) {
			let output: Output;
			if (kind === "decision" && isDecisionDraft(proposal)) {
				output = { kind, draft: structuredClone(proposal) };
			} else if (kind === "lesson" && isLessonDraft(proposal)) {
				output = { kind, draft: structuredClone(proposal) };
			} else {
				rejected++;
				continue;
			}

			const key = fingerprint(output);
			if (seen.has(key) || state.drafts.has(key)) {
				duplicates++;
				continue;
			}
			state.drafts.set(key, output);
			buffered++;
		}

		return {
			content: [{ type: "text" as const, text: `Buffered ${buffered}; ${duplicates} exact repeats; ${rejected} rejected. No files written.` }],
			details: { buffered, duplicates, rejected },
		};
	}

	const decisions: AgentTool<typeof DecisionsSchema> = {
		name: "record_decisions",
		label: "Buffer decisions",
		description: "Buffer durable project decisions with inferred attribution and repository-relative file paths.",
		parameters: DecisionsSchema,
		execute: async (_id, params: Static<typeof DecisionsSchema>) => collect("decision", params.decisions),
	};
	const lessons: AgentTool<typeof LessonsSchema> = {
		name: "record_lessons",
		label: "Buffer lessons",
		description: "Buffer reusable technical project lessons, excluding personal/private information.",
		parameters: LessonsSchema,
		execute: async (_id, params: Static<typeof LessonsSchema>) => collect("lesson", params.lessons),
	};

	return {
		addon: {
			systemPrompt: `${CAPTURE_PROMPT}\nProject root for repository-relative file paths: ${JSON.stringify(projectRoot)}.`,
			tools: [decisions, lessons],
			complete() {
				if (state.phase === "collecting") state = { ...state, phase: "ready" };
			},
		},
		async flush() {
			const ready = state.phase === "ready" ? state.drafts : undefined;
			// Consume before any await: retries, concurrent flushes, and late completion cannot release twice.
			state = { phase: "consumed" };
			if (!ready || !canWrite()) return;

			const capturedAt = new Date();
			const failures: Error[] = [];
			const decisionDrafts = [...ready].flatMap(([key, output]) =>
				output.kind === "decision" && !seen.has(key) ? [output.draft] : []);
			if (decisionDrafts.length > 0 && canWrite()) {
				try {
					// Share one ADR lock acquisition and timeout across the pass's validated decisions.
					const saved = await writeDecisions(projectRoot, decisionDrafts, capturedAt, canWrite);
					for (const draft of saved) seen.add(fingerprint({ kind: "decision", draft }));
				} catch (error) {
					failures.push(new Error(`decision: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
				}
			}

			for (const [key, output] of ready) {
				if (output.kind !== "lesson" || seen.has(key) || !canWrite()) continue;
				try {
					const saved = await writeLessons(projectRoot, [output.draft], capturedAt, canWrite);
					if (saved.length > 0) seen.add(key);
				} catch (error) {
					failures.push(new Error(`lesson: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
				}
			}

			if (failures.length > 0) {
				throw new AggregateError(failures, `Durable memory persistence failed: ${failures.map((error) => error.message).join("; ")}`);
			}
		},
	};
}
