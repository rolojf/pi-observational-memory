# Durable project memory

This fork adds optional project-level decision history and reusable lessons to the existing reflector. It is off by default. The upstream npm package does not contain this fork-only feature; load/install this fork's built extension to use it.

## Enable it

Add this separate section to the session working directory's `.pi/settings.json`, preserving other settings:

```json
{
  "durable-memory": {
    "enabled": true
  }
}
```

Reload Pi after changing settings. Agent-directory `settings.json` also supports the section; project settings override it. Prefer project-level opt-in unless you intentionally want capture across your projects.

The output root defaults to the current Git worktree root, including when the session starts in a subdirectory. Outside Git, set `projectRoot` explicitly:

```json
{
  "durable-memory": {
    "enabled": true,
    "projectRoot": "."
  }
}
```

Paths resolve relative to the session cwd and support `~/`. An explicit root must contain the cwd and cannot escape its current Git worktree. Invalid settings disable durable memory with a warning; they do not disable ordinary session memory. No directories or artifacts are created merely by enabling the feature.

## What gets written

When the reflector already runs, it can select normal session reflections and independently select:

- **Decisions** for `<project>/ADR.jsonl`: choices tied to source paths, with attribution and optional rationale.
- **Lessons** for `<project>/MEMORIES/*.frontmatter.md`: reusable technical knowledge, with searchable metadata and a Markdown body.

The model supplies structured fields. Code handles dates, IDs, filenames, JSON escaping, and writes. There is no additional extraction worker or per-record approval queue. Extra output/tools can consume additional tokens and turns within the existing reflector's limits.

This is best-effort capture from the reflector's bounded observations. It does not verify claims against raw conversation, require evidence, scan prior ADRs, reconcile statuses, or guarantee exhaustive coverage. Short sessions that never trigger reflection produce no automatic exports. Existing cadence, passive mode, model selection, and idle-mode cancellation still apply.

### Decision format

One standard JSON object per line:

```json
{"id":"generated-id","date":"2026-07-28T22:53:30.000Z","who":"user","files":["src/runtime.ts"],"decision":"Accept headers-only authentication","reason":"OAuth providers may not supply an API key."}
```

- `date` is the capture timestamp, not a verified original decision time.
- `who` is the reflector's inference: `user`, `agent+user`, or `agent`.
- `files` contains literal repository-relative paths, not globs.
- `reason` is optional. Evidence, status, alternatives, and supersession are not required fields.
- A later entry for the same file does not automatically invalidate older decisions.

Standard JSON serialization handles embedded newlines, quotes, backslashes, and Unicode. There is no custom encoder or UUID executable dependency. The old `ADR.tsv` reference is not imported or modified.

### Lesson format

```markdown
---
description: "A concise reusable technical lesson."
datetime: 2026-07-28T18:53:30.000-04:00 # EDT
tags: [memory, relevant-topic]
---

The lesson and useful explanation.
```

New lesson dates use the machine's local offset and zone at capture time. Existing dates are not rewritten on read. Filename collisions create a disambiguated filename rather than overwrite another lesson. The original memory skill is not needed at runtime.

## Finding saved knowledge

The agent receives `memory_lookup` when the feature is enabled:

```text
memory_lookup({ action: "decisions", path: "src/runtime.ts" })
memory_lookup({ action: "lessons", query: "oauth" })
memory_lookup({ action: "lesson", scope: "project", file: "selected-lesson.frontmatter.md" })
```

Decision queries accept repository-relative or absolute in-project paths. Results show up to eight recent append-order decisions with clipped fields, capture dates, attribution, and an omitted-record count. They are history, not a computed current policy. The extension also attaches matching decisions to successful supported `read` results.

Lesson discovery inspects filenames and frontmatter, not complete bodies. Bounded read-ahead may include bytes adjacent to the header, but those body bytes are not parsed or exposed in metadata results. Listings inspect at most 1,000 eligible entries and return at most 20 matches, with omission/scan-limit indicators. Body reads are bounded and restricted to the selected memory root.

Optional shared lessons can be read by configuring a root:

```json
{
  "durable-memory": {
    "enabled": true,
    "sharedMemoryRoot": "~/MEMORIES"
  }
}
```

Use `scope: "shared"` to read a lesson selected from that root. Shared roots are read-only: automatic export and cross-project promotion are not implemented. The extension does not discover or inspect unrelated projects.

### Preserve or review

The agent is instructed to preserve human-attributed decisions by default. If the current request conflicts, it should explain the conflict and ask whether to keep or review the earlier decision. Ordinary compliant edits do not need confirmation. Inferred attribution may be wrong; an unnecessary review prompt or preservation of a misattributed decision is an accepted limitation.

Retrieval is **advisory**, not an edit permission gate. A read annotation can inform the next model turn, but cannot affect a sibling edit already chosen in the same response. Nested tool scripts may suppress results. Direct edits without a read/lookup, shell commands, and third-party mutation tools are not automatically protected. No blocking retry protocol is installed.

## Failure and privacy boundaries

- Drafts remain buffered until a clean reflector attempt completes. Failed attempts do not export; fallback receives a fresh buffer.
- One integration-owned lifecycle epoch invalidates capture and pending retrieval on session changes and Pi session-tree navigation. Capture guards are rechecked at delayed write boundaries. Normal branch growth and compaction do not themselves cancel valid capture.
- Only successful writes enter the current session's cheap exact-repeat set. Cross-session/semantic deduplication and historical organization are deferred.
- Independent outputs may succeed when another fails. Write failures produce warnings without causing a model fallback or changing reflection coverage/dropper eligibility.
- Cooperating ADR writers use a bounded lock. **Known operational limitation:** a process crash can leave `ADR.jsonl.lock`, causing later ADR writes to warn and fail until it is removed. Verify that no writer is active before manually removing a stale lock. Locks are not automatically stolen, because unsafe recovery can corrupt concurrent writes. Session memory and lesson writing remain independent; crash-safe exactly-once delivery is not promised.
- Reader failures preserve normal file reads. Malformed/oversized ADR rows are diagnosed and skipped rather than silently treated as decisions.
- Project artifacts may be committed or published. Reflector guidance excludes secrets and personal/private session details, but this is not a factual/privacy auditing system; inspect repository changes before publication as usual.

## Implementation and maintenance

Custom behavior lives in `src/durable-memory/`. Existing files only supply the optional reflector addon, its attempt/release wiring, and entry-point registration. The original reflector prompt, observer/dropper implementations, ledger formats, and compaction code remain unchanged.

Run `npm test`, `npm run typecheck`, and `npm run build` after changes. The build regenerates `dist/index.ts`, which Pi actually loads. See [implementation context](plan_context/durable-memory.md) for the accepted tradeoffs and [../PLAN.md](../PLAN.md) for remaining work.
