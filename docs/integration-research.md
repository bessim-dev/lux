# Integration research and review record

Research date: 8 October 2026. Lux baseline: `00c8d93559a292c8aa2f9e68338f3731b1ab170b`. Related repository inspected read-only: `REOTECH/pgf-sync-engine`, local revision `858b7602c2fb202fc96d0d58ffde6d63c4afff1d`.

This records observed code, current primary-source documentation, independent Claude/Codex findings, and the decisions in [agent integration](agent-integration-plan.md) and [Git integration](git-integration-plan.md). No live Plane inventory, provider capability check, production import, deployment, or sync-engine test run was performed. Current upstream documentation does not prove compatibility with the installed self-hosted services.

## Protocol and context findings

The MCP 2026-07-28 revision makes protocol requests stateless, permits explicit application handles, introduces discovery, and deprecates Roots. Choose pinned bindings or per-call context selectors rather than a mutable connection-wide workspace. Protocol statelessness does not forbid an authenticated service from resolving a durable handle. [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [lifecycle](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle).

The official TypeScript SDK v2 is the current stable line. Its compatibility adapter serves older protocol clients as well as the new revision. Pin packages and prove the actual client/transport matrix before release. [SDK](https://ts.sdk.modelcontextprotocol.io/v2/), [compatibility guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).

Claude Code can defer MCP tool definitions with tool search. Tool names, server instructions, and plugin metadata still have a cost, and support depends on configuration. Keep the Claude plugin thin and avoid duplicate registration. Codex can use the same remote or local server through its documented MCP configuration. [Claude MCP](https://code.claude.com/docs/en/mcp), [plugins](https://code.claude.com/docs/en/plugins), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Cloudflare's discovery/execution approach and Anthropic's code-execution examples support filtering and bulk processing outside model context. They do not demonstrate that an arbitrary-code sandbox beats six typed tools for Lux. Measure complete workflows, including retries and latency, before adding one. Proposed token budgets in the plan are targets, not results. [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode-mcp/), [Anthropic code execution](https://www.anthropic.com/engineering/code-execution-with-mcp).

Clerk documents MCP OAuth support including client metadata and registration paths. Lux currently requires a Convex-audience JWT and verified email. An inbound MCP OAuth token does not automatically satisfy that boundary. The first MCP gate is a working browser/MCP identity equivalence proof with issuer, exact canonical resource/audience, scope, and expiry validation. [Clerk overview](https://clerk.com/docs/guides/ai/overview), [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Convex auth configuration](../convex/auth.config.ts), [Lux permission helpers](../convex/access.ts).

## Lux implementation constraints

- `convex/schema.ts` and `convex/access.ts` store and decode generic JSON entity payloads. The existing workspace snapshot and generic writes read broad workspace collections. Add focused indexed operations for agents and paginate the UI before a large import.
- `shared/model.ts` has a fixed status catalog, one assignee, embedded subtasks, and no first-class Plane cycles/modules/pages/custom fields. Import fidelity needs a mapping report and model extensions, not only a transport.
- `convex/entities.ts` assigns interactive task keys and author/timestamps. `convex/files.ts` limits files to 25 MB and attributes uploads to the current member. A restricted import path must preserve provenance without weakening normal interactive permissions.
- The manual-link implementation uses its own table and indexed task/project queries. This follows existing permission helpers and avoids attaching link data to workspace snapshots. Its URL classification is explicitly unverified.

## Primary verification of the sync engine

Codex mapped adapters, ingestion, worker, database, and policy boundaries. The primary checked the consequential claims against local code. These are issues to resolve in the separate sync-engine implementation, not fixes made by this Lux PR.

| Intended invariant                     | Observed local implementation                                                                           | Required follow-up                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Persisted link survives PR text edits  | `src/sync/processor.ts` prefers `event.planeIdentifiers[0]` over the persisted identifier               | Make explicit stored links authoritative; parsed text produces suggestions only.                                 |
| Durable intake before acknowledgement  | `src/server.ts` saves delivery and event in separate calls                                              | Atomically persist delivery and job; a crash between them must not make replay discard the event as a duplicate. |
| Worker recovers interrupted processing | `src/db.ts` claims pending/retry rows, but does not reclaim expired processing rows                     | Reclaim expired leases and test crashes during effects.                                                          |
| Provider identity separates instances  | Provider/domain identity contains kind and owner/name without a mandatory host/immutable repository key | Include instance/host and verified repository identity; two Forgejo hosts must not collide.                      |
| Provider event order is preserved      | `src/providers/common.ts` sets receipt time with `Date.now()`                                           | Distinguish receipt and provider timestamps; refresh authoritative current state when ordering is uncertain.     |
| Event dedupe is reliable               | `migrations/001_initial.sql` permits nullable values in unique dedupe fields                            | Define a mandatory scoped dedupe key and altered-body conflict behavior.                                         |

The existing identifier regex is also too broad for safe task routing and does not model Lux project keys with hyphens. Neither title/body parsing nor a provider webhook grants Lux project access. Validate instance/workspace/project context before suggesting or approving links.

## Independent review decisions

Claude reviewed security and architecture; Codex inspected the local implementation and UI patterns. The plan adopted these findings:

- Lux owns explicit links and access grants. During transition, pgf-sync-engine remains the sole Git-ingestion/policy worker with a typed Lux destination and idempotent effects. Avoid two independent automation writers.
- Private provider metadata needs a defined audience policy. A member's provider token must not populate a workspace-wide mirror that other Lux readers can see without an appropriate grant.
- Context selectors and caches must remain principal/instance scoped and recheck current grants after revocation.
- Repository renames, force pushes, dismissed reviews, reopened PRs, unknown check requirements, and multiple linked PRs require current-state reconciliation before automation.
- Full Plane replacement must reconcile mappings, permissions, original attribution, attachments, and automation cutover.

The primary corrected two review interpretations. Opaque application handles are compatible with stateless MCP requests. Resource/audience validation must follow the advertised canonical resource identifier rather than universally discard its path. The review's Forgejo header/version concerns remain an actual-instance compatibility gate; this research did not verify the deployed version.

## Provider source checks

GitHub documents SHA-256 HMAC verification over raw bytes, constant-time comparison, least-privilege App permissions, quick durable acknowledgement, and delivery IDs for deduplication. Use a GitHub App for future shared repository grants; start with only the permissions/events the supported read model needs. Checks are bound to commits, so old-head success cannot prove the latest PR head is green. [Webhook verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [check runs](https://docs.github.com/en/rest/checks/runs).

Current Forgejo upstream documents its own event/delivery headers and plain hexadecimal `X-Forgejo-Signature` HMAC. Token scopes and repository restrictions must be verified on the actual installed instance. Do not assume every GitHub review/check event or rules API exists in Forgejo. [Forgejo webhooks](https://forgejo.org/docs/latest/user/repository/webhooks/), [token scopes](https://forgejo.org/docs/latest/user/authentication/token-scope/), [API usage](https://forgejo.org/docs/latest/user/api/usage/).

Plane's public API documentation is a starting point for pagination/export coverage. Before migration, inventory the installed edition/version, source workspaces, available native export/backup, unsupported records, and actual rate-limit behavior. No source counts or full-fidelity claims were produced here. [Plane API introduction](https://developers.plane.so/api-reference/introduction).

## Remaining proofs

MCP identity and compatibility, context-token benchmarks, actual repository grants/provider capabilities, durable worker recovery, full Plane inventory/model mapping, and a staging import rehearsal are still required. The working slice in this PR is manual task PR URL linking, with real browser and Convex verification recorded in the PR. It does not establish any of those later proofs.
