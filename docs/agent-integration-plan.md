# Agent access and Plane migration

Status: proposed design, not an implemented integration. Research date: 8 October 2026.

Lux should expose the same authorized operations through a shared MCP service, a CLI, and a thin Claude plugin. GitHub and Forgejo PR connections are part of this design; see [Git integration](git-integration-plan.md). [Research findings](integration-research.md) records evidence, independent reviews, and unresolved implementation gates.

## Decisions

- Keep Convex persistence and Clerk authentication. Use strict TypeScript and shared Zod contracts for new integration code.
- Put business rules and permission checks in the Lux service. MCP, CLI, web UI, and the importer use shared operations, rather than separate implementations of those rules.
- Use a small typed MCP tool catalog initially. Use deterministic code for bulk migration and Git-event processing. Measure complete workflows before adopting a discovery/code-execution sandbox.
- Include isolated workspace/project bindings from the first version. An agent must not depend on an account-wide mutable current workspace.
- Treat migration fidelity and Git automation cutover as separate completion gates. Moving task rows is insufficient to replace Plane.

## Existing constraints

[The schema](../convex/schema.ts#L4) stores entities in validated JSON payloads, indexed by workspace or workspace/kind/key. [The workspace query](../convex/workspaces.ts#L76) and [generic mutation](../convex/entities.ts#L14) load whole workspaces. Filtering the results in an MCP handler would save model tokens while retaining backend scans.

[Access helpers](../convex/access.ts#L9) require a verified user and bind memberships to `tokenIdentifier`. They enforce private-project visibility and editing permissions. New integration paths should share these rules.

[Task creation](../convex/entities.ts#L85) allocates keys and replaces timestamps. [Comment writes](../convex/entities.ts#L107) enforce current-user attribution. [Uploads](../convex/files.ts#L28) have a 25 MB limit and replace attribution. These interactive rules cannot faithfully import historical records.

[Tasks](../shared/model.ts#L57) have five fixed states, one assignee, string labels, and embedded subtasks. Lux has no first-class cycles, modules, pages, configurable workflows, custom fields, or source-ID mappings.

## Service and authentication

A small TypeScript gateway exposes HTTPS `/mcp` with Streamable HTTP and OAuth metadata. The CLI uses a narrow versioned HTTP contract backed by the same Convex functions. A local `lux mcp` stdio adapter adds repository-aware configuration for clients that need it. Use the official MCP SDK v2 with its new/legacy protocol compatibility; test actual clients rather than assume support from their names.

Clerk documents MCP OAuth support, but Lux's actual Clerk instance, grant scopes, resource validation, and middleware/SDK v2 compatibility need proof. Prefer authorization code with PKCE and Client ID Metadata Documents; support legacy registration only where a tested client requires it. Do not build a custom authorization server by default.

The first gate is identity equivalence. Lux currently trusts JWTs with audience `convex`; an MCP OAuth token is not automatically that JWT. Verify issuer, audience/resource, subject, expiry, granted scopes, and verified-user status. Prove that browser and MCP access resolve to the same Lux member. Evaluate direct Convex validation or a narrowly authenticated principal exchange. Never accept a caller-supplied user ID as authority, relay tokens with an incorrect audience, or expose deployment keys to clients.

Every call intersects scopes with current workspace membership and project rights. Revocation must affect subsequent calls, including cached reads. Separate read, task-write, comment-write, and restricted import grants. Namespace credentials and caches by instance and principal; data caches also include workspace, project, and grants. Use an explicitly authorized automation principal for unattended jobs.

Add a security audit log with the actual actor, client, affected IDs, idempotency/request ID, and outcome. The existing activity feed is client-reported and is not that log. Keep credentials and full private descriptions out of logs. Task descriptions and imported/provider content are data, never executable instructions.

## Project context

Proposed one-time setup, followed by ordinary commands:

```sh
lux auth login
lux link --workspace reotech_internal --project LUX
lux tasks list --mine
lux task get LUX-42
```

`lux link` resolves names to immutable Lux instance/workspace/project IDs. Store non-secret, versioned context in `.lux.json`; store credentials in the OS credential store. Discover the binding while walking upward to the Git root. A checked-in mapping follows worktrees; private local overrides stay outside tracked files. In monorepos, explicitly configured directory mappings use the closest match. Normalize Git remotes as suggestions for repository binding, not as authorization.

Resolve explicit overrides, repository/directory bindings, named profiles, then interactive selection. Invalid bindings fail; they never silently fall through to another workspace. Headless ambiguity returns `CONTEXT_REQUIRED` with a bounded authorized choice list. Identical task keys in different workspaces resolve inside the pinned context. Cross-workspace calls require explicit qualified references.

A local MCP process pins its binding at startup from an explicit project directory or verified harness-provided directory. Claude supplies `CLAUDE_PROJECT_DIR`; other clients need their own verified configuration. The design does not require MCP Roots, which the latest specification deprecates.

Remote agents cannot inspect local working directories. Configure a non-secret project-bound connector or use `lux_context` to return a short immutable context handle. A project-bound endpoint's OAuth resource metadata and audience handling must pass the identity/compatibility proof before shipping. Bindings select scope and grant no access themselves. Recheck authorization on every call. Never infer a current project from transport-session state. Two simultaneous agents must keep independent contexts.

## Initial tools and plugin

| Tool              | Contract                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `lux_context`     | Discover/resolve authorized workspace, project, and repository bindings; return a pinned context.        |
| `lux_search`      | Search/list allowed projects or tasks with typed filters, bounded limits, cursor, and concise summaries. |
| `lux_get`         | Fetch one referenced record; select sections and paginate comments/history/linked PRs independently.     |
| `lux_create_task` | Create a task from a small typed request and return its assigned key.                                    |
| `lux_update_task` | Apply a typed patch with expected version and idempotency key.                                           |
| `lux_add_comment` | Add an attributed comment idempotently.                                                                  |

Do not expose the generic JSON before/after mutation directly to agents. Define input/output schemas, accurate read/write annotations, bounded actionable errors, and canonical scope on context resolution and mutations. Keep essential access available as tools; optional MCP resources/prompts must not be the only route to information. PR-specific tools are introduced only when the Git phase exists.

The Claude plugin packages MCP setup and one short progressively loaded workflow skill. It explains linking, scoped reads, conflicts, and the CLI. It does not duplicate the entire tool catalog, inject workspace snapshots, automatically migrate data, or register a second copy of the same server. Other harnesses connect to the shared MCP directly, or use the CLI when shell access is available.

## Efficiency from v0.0

Add indexed columns for workspace/project/kind, task filters, and search text alongside existing payloads, with a validated backfill and transactional updates. Use focused reads and writes. Move to dedicated task/comment tables only when measured query and import scale justify that change.

Authorize before returning snippets, counts, or pagination metadata. Default to about 20 summary rows, with a hard cap such as 100. Omit descriptions, comments, reactions, and file bytes until requested. Return continuation metadata when an output budget is reached; never silently describe a truncated result as complete. Paginate the web UI's snapshot/subscription path before a large import too.

Keep tool names/order stable and descriptions/server instructions short. Return validated structured data with compact text for client compatibility; measure whether hosts inject both representations into context. JSON formatting, HTTP compression, and prompt caching do not replace bounded results.

Keep transformation loops, aggregation, attachment transfers, and bulk imports outside model context. Agents request jobs and inspect summaries. Durable job IDs/status reads work even when clients lack the optional MCP Tasks extension. CLI batch output and targeted MCP calls should be compared by complete task cost.

Proposed budgets, not measured results: at most 2,000 tokens for a fully loaded catalog/instructions and roughly 1,500 tokens for a default task page without descriptions. Benchmark Claude Code discovery, an eager MCP client, Codex, and CLI workflows. Record success, tool calls, retries, tokens, latency, and backend rows/bytes read. Change the design when evidence supports it, not simply to minimize tool count.

## Plane migration

Run a resumable TypeScript job against source APIs/export and a restricted Lux import service. An LLM reviews mappings or monitors progress; it does not copy every item through MCP.

1. Inventory the installed Plane version/edition, explicit source-workspace manifest, counts, permissions, archived records, and API/export coverage. `reotech_internal` is the configured source in current local guidance, not proof of the full requested inventory.
2. Capture a consistent snapshot and attachment manifest. Use pagination and actual server rate-limit headers. If APIs omit records/history/pages, plan an authorized native export/backup route and report that gap.
3. Map every field to native Lux representation, retained original archive, or a required feature. Preserve rich-text originals/provenance. Archiving data does not make it editable/searchable as a native Lux entity.
4. Resolve configurable/cancelled states, multiple assignees, parent/child work items, cycles/modules/pages, label IDs, custom fields, relations/links, former members, original authors/dates, archived items, and files over 25 MB. Historical attribution must not grant active access. Stage private projects restrictively until permissions pass verification.
5. Persist mappings by source instance/workspace/kind/ID. Keep Lux IDs independent. Preserve Plane keys as aliases, or native keys where safe; seed counters above imported maxima. Handle existing Lux records and collisions. Preserve source timestamps/authors separately from actual importer identity. Retry must not duplicate records/comments/files.
6. Import identity mappings, workspaces/projects/permissions/catalogs, tasks, relation edges, comments/history, and attachment bytes with checksums. Checkpoint bounded transactions. Define snapshot versus delta replay and rollback ownership; reject rollback over later user edits.
7. Reconcile counts, references, hashes where normalization allows, authorship/dates, key aliases, permissions, and attachment checksums. Retain exception reports. Every source field must be mapped, archived, or explicitly reported before claiming full fidelity.
8. Rehearse in staging with real owner/member/guest interactions and file downloads. Coordinate the final snapshot/delta with paused source writers. Cut over pgf-sync-engine and reconcile queued/in-flight events. Retain Plane and backups until acceptance; no automatic source deletion.

## Implementation slices and gates

1. Identity and compatibility proof, pinned contexts, current/legacy MCP clients, and simultaneous workspaces. Resolve actual hosting and SDK/helper compatibility.
2. Indexed context/search/get and focused task mutations, with strict types, conflicts, idempotency, and existing convex-test coverage extended for access isolation.
3. CLI login/link/profiles/diagnostics, six tools, and the thin Claude plugin. Verify actual Claude/Codex interactions and measure context budgets.
4. [Git repository bindings and manual PR linking](git-integration-plan.md), read mirrors, durable webhook/reconciliation processing, and optional lifecycle policy after shadow validation.
5. Migration inventory, required model extensions, importer, staging rehearsal, scale checks for API and UI, then controlled data/automation cutover.

The initial integration PR recorded this design and implemented manual task PR URL references. The [shared MCP foundation](shared-mcp-foundation.md) adds indexed read operations and local MCP/CLI/plugin access with repository bindings. Hosted OAuth identity mapping, write tools, provider grants, status sync, and migration remain separate gates. No production migration or provider synchronization has been activated.
