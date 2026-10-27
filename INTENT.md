# Durable project memory integration

## Purpose

Extend observational memory so useful decisions and lessons survive beyond one Pi session. Reuse the existing reflector rather than add another extraction worker, and keep the integration easy to maintain alongside upstream updates.

## Agreed behavior

- The observer and reflector remain trusted, best-effort selectors. Each actual reflector run may produce normal session reflections, architectural decisions, durable lessons, or any combination.
- Automatically append selected decisions to `<project>/ADR.jsonl` and write selected lessons as Markdown memory files. No per-record review queue, required evidence, source-verification pass, or additional extraction model is wanted.
- Keep attribution as the reflector judges it. Preserve human-attributed decisions by default; surface relevant history when working on its files, and ask whether to keep or review a decision only when the requested change conflicts with it.
- Capture cheaply. Do not scan prior decisions during reflection to merge records, update statuses, or infer supersession. Later maintenance may organize the history.
- Use ordinary JSON serialization, not TSV or a custom encoding tool. Keep the decision and rationale, not merely a list of touched files.
- Treat the original memory skill and ADR design as design references, not runtime dependencies or a second set of capture instructions.
- Before modifying an upstream file, evaluate an additive alternative. Small explicit integration changes are acceptable when cleaner than duplication or interception workarounds.

## Boundaries

- Preserve the existing observation, compaction, reflection-coverage, and dropper behavior. A disk export is not permission to discard session context.
- Keep basic file-integrity, path-containment, cancellation, and privacy protections. Committed project artifacts must not deliberately include personal/private session information.
- Attribution and selected content can be mistaken or incomplete. This is an accepted limitation, not a requirement to add a verification system.
- Retrieval supplies historical context, not proof that the newest entry supersedes every older entry mentioning the same file.

## Not part of the first implementation

Historical backfill; evidence auditing; mandatory human ratification; automatic status reconciliation; semantic deduplication; a vector index; automatic cross-project promotion; migration/deletion of existing reference files; or a separate collaboration-evidence ledger.

## Planning

Implementation progress is in [PLAN.md](PLAN.md). Technical choices and acceptance tests are in [docs/plan_context/durable-memory.md](docs/plan_context/durable-memory.md). The implemented first version is described in [docs/durable-memory.md](docs/durable-memory.md), including its known operational limitations.
