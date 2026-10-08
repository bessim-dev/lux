# GitHub, Forgejo, and Git connections

Status: manual task PR URL references implemented; authenticated provider connections and sync are proposed. The future agent integration uses the [service and context contract](agent-integration-plan.md). Evidence and review responses are in [research findings](integration-research.md).

The initial goal is to connect Lux tasks/projects to repositories and PRs, then expose concise PR state to agents and the web UI. Providers remain authoritative for code, reviews, and checks. Lux owns tasks and explicit task links. Git itself supplies remotes, commits, and branches; it does not supply a provider-independent PR/review API.

## Identity and bindings

Use `provider kind + canonical provider instance + immutable repository ID` for repository identity. PR identity adds the provider's external PR ID, with its number as a display/lookup field. Names and URLs can change after a repository rename/transfer; update aliases from verified provider data. Two Forgejo hosts can contain the same owner/repository/PR number.

Store separate records for:

- Provider connections with credential references, capability/version evidence, grant revision, enabled status, and authorized repository allowlist.
- Repository metadata keyed by provider instance/external ID.
- Repository-to-Lux bindings containing workspace/project IDs, visibility policy, and authorized integration effects. Multiple repositories can serve one project. Shared-repository/monorepo mappings must be explicit; ambiguous mapping never grants access.
- PR snapshots containing current head/base refs and SHAs, draft/open/closed/merged state, review/check summaries, provider URLs, fetched time, capability limits, and stale/unknown state.
- Many-to-many task/PR links with explicit source, creator, blocking/optional/superseded flags, and audit/version metadata.
- Delivery/job/effect records, plus optional branch/commit references keyed by repository and full object ID.

Index by binding/project, repository/PR, task/link, and retry schedule. Use typed tables for integration records rather than hiding them inside task descriptions.

The CLI resolves repository binding from a normalized SSH/HTTPS remote once and persists immutable IDs alongside project context. Remotes are discovery hints; a malicious or renamed remote cannot authorize a repository. Nonstandard SSH aliases/ports and monorepos may require explicit selection. Do not rely on `origin` or a hardcoded `main` branch. Local-only Git can attach commit/branch references without claiming PR support.

## Connection and read authorization

For GitHub, prefer a GitHub App installed on selected repositories with read-only permissions for the required PR/review/check/status endpoints. Map every endpoint/event to its actual permission. Request Contents read only when code/commit access is included; do not request write/administration merely to mirror PRs.

For Forgejo, discover the installed version and API capabilities. Use a dedicated non-admin identity with narrowly scoped read credentials. Specific-repository tokens exist in current upstream docs, but the deployed instance may predate them. In that case, use a dedicated account restricted to the approved repositories. Configure a repository webhook through an appropriately authorized setup user; steady-state read credentials need not retain hook-administration rights.

An integration grant requires authorized Lux project management and provider repository access. A provider webhook signature proves delivery authenticity, not Lux membership. Never create a human Lux membership from a Git author or interpret a PR's task key as authorization.

Private provider metadata must not become readable to every workspace member just because an App can fetch it. Initial policy: mirror it only into an explicitly restricted Lux project whose approved audience is no broader than the repository audience; otherwise require verified per-user provider access or redact it. Revalidate access/installation/grant revision, define a short permission-cache lifetime, and invalidate mirrored sensitive reads on disconnect/revocation. Visibility applies to titles, summaries, counts, search hits, links, and notifications.

Configured provider hosts and API paths must be allowlisted. Validate canonical URLs without embedded credentials; block unexpected redirects and arbitrary token-bearing requests. Approved self-hosted/private-network Forgejo needs an explicit host policy. PR content, URLs, and webhook bodies cannot choose credential destinations.

## Task and PR linking

Proposed commands, after repository/project setup:

```sh
lux repo connect
lux pr link https://github.com/owner/repo/pull/42 --task LUX-17
lux task get LUX-17 --include prs
lux pr get 42
```

Resolve the PR through a configured provider and immutable repository identity. Enforce current Lux rights, repository grant, task/project association, and visibility before persisting a link. `42` is only meaningful inside a bound repository; URLs or qualified references work when several repositories are connected.

An explicit persisted link is authoritative. PR-body/title/branch task references produce suggestions in v0.0, not task mutations. A later opt-in auto-link policy may adopt one unambiguous authorized match, but must never silently retarget an existing link. Prefer explicit Lux metadata, then body, title, branch; preserve source/provenance. Parse against the actual configured Lux key grammar, including project keys containing hyphens. More than one candidate or mapping is an unresolved suggestion.

Unlink/relink is audited and concurrency checked. One task can span GitHub and Forgejo PRs; one PR can explicitly relate to several tasks. Optional and superseded links remain visible without blocking readiness.

Add `lux_pr_link` and `lux_pr_get` only in the Git slice. `lux_get` task sections include concise linked-PR summaries; listing filters can be extended through `lux_search`. Return current head, draft/lifecycle, aggregate review state, check summary, freshness, and URL. Fetch full diffs/comments/logs only when requested and independently bounded. Linking is a Lux write, not permission to comment on or merge a provider PR.

## Webhooks and reconciliation

1. Bound the raw request body before expensive parsing. Select the configured connection/secret from a trusted route binding. Verify HMAC-SHA256 over unmodified bytes with constant-time comparison. Validate GitHub's `X-Hub-Signature-256` or Forgejo's `X-Forgejo-Signature` and the corresponding event/delivery headers. Legacy aliases require explicit adapter evidence.
2. Verify the signed payload repository/installation belongs to that connection. Persist delivery ID, hash, and the processing job atomically before acknowledging. Deduplicate by connection/provider instance/delivery ID. A repeated ID with a different body is a rejected conflict, not an ordinary duplicate.
3. Treat events as hints to refresh authoritative provider state. Normalize supported PR/review/status/check events through typed adapters; do not assume GitHub and Forgejo event parity. Record unsupported capability as unknown.
4. Process bounded jobs with recoverable leases, backoff, dead-letter visibility, and idempotent effects. Interrupted processing must become eligible after lease expiry. Handle duplicates, out-of-order events, force pushes, review dismissal, PR reopen, and provider/API failures.
5. Serialize/coordinate refreshes per repository/PR and commit snapshots with expected versions. A slow fetch cannot overwrite a newer fetch. Keep provider timestamps/revisions where useful and fetch complete current state when ordering is ambiguous.
6. Key checks by repository, head SHA, external check/run/context, and check producer where available. Recompute requirements from provider branch protection/rules or an explicit validated project policy. Old-head success cannot make a new head green. Unknown requirements or unavailable review information remain unknown. Neutral/skipped results follow provider/policy semantics rather than a global assumption.
7. Reconcile periodically and on reconnect. Never assume webhooks are exhaustive or automatically redelivered. Record `lastFetchedAt`, stale status, rate limits, and reconciliation cursors. Bindings changing while jobs are queued require grant-version revalidation, not implicit rerouting to a new project.

## Existing sync engine and lifecycle authority

The separate `pgf-sync-engine` already has GitHub/Forgejo adapters, a normalized event vocabulary, delivery ledger, worker leases, task links, and policy evaluation. Reuse its boundaries and evaluated concepts. Do not blindly copy its current code; [the research record](integration-research.md#primary-verification-of-the-sync-engine) identifies gaps between its intended invariants and implementation.

Default ownership: extend pgf-sync-engine with a typed Lux destination adapter and durable effect outbox. Its PostgreSQL worker remains the sole Git-ingestion/policy worker during the transition. Lux stores project bindings, authoritative links, authorized PR read models, and idempotent destination effects. It does not start a second competing policy engine. Adapter and link synchronization contracts need explicit revisions and replay semantics. If pgf is later retired, transfer ownership/checkpoints in a controlled cutover and disable its old writer before activating a Lux-native worker.

Start with explicit links and read mirrors. Keep lifecycle automation disabled or in shadow mode. Optional later policy evaluates every active blocking link, current-head checks, current required reviews, unresolved blockers, and manual overrides. A merged PR alone does not complete a task; closing an unmerged PR does not automatically cancel it. Human QA/release acceptance stays explicit. Source and target state catalogs need mappings.

Do not write task descriptions, private backlinks, provider comments, labels, reviews, branches, merges, or releases during the initial read-mirror phase. Each future provider-write feature requires its own grant, operation contract, idempotency strategy, and explicit user intent. Prevent event loops with source/effect IDs rather than reposting every change.

## Acceptance and rollout

- Both providers yield equivalent results for supported fixture scenarios; unsupported states are visibly unknown.
- Duplicate deliveries, altered payloads, bad signatures, missing headers, oversized input, and cross-instance identity collisions behave correctly.
- Inject crashes after ingestion and during effects; replay recovers without losing work or duplicating comments/links. Expired processing leases are reclaimable.
- Persisted links survive title/body/branch edits. Ambiguous keys, shared repositories, and cross-workspace references never auto-authorize links.
- Private PR metadata cannot leak via reads/search/counts or cached data after revocation; a fork PR author does not gain Lux rights.
- Force-pushed heads, delayed checks, concurrent refreshes, dismissed approvals, reopened PRs, repository renames, and installation removal converge safely.
- Several PRs across both providers can block one task. Optional/superseded links and manual overrides behave as configured.
- Run a read-only staging canary on the actual GitHub and Forgejo instances before activating webhook writes or task-state effects. Confirm scopes/capabilities, backfill PRs, reconcile, and exercise disconnect.

This PR implements manual PR URL references on tasks. The drawer adds, removes, and opens links through dedicated indexed Convex operations. Each operation checks current workspace membership and project permissions. Links are bounded at 50 per task, canonicalized and deduplicated, and deleted with the task/project. The query subscribes only while that task drawer is open; links are excluded from full workspace snapshots and generic entity writes.

This smaller slice makes no provider request and stores no credentials, fetched private metadata, or verified repository identity. HTTPS GitHub `/owner/repo/pull/number` and Forgejo-shaped `/owner/repo/pulls/number` URLs are references only; any host with the latter shape is classified as Forgejo without server verification. The parser strips query/fragment/trailing slash, normalizes host and owner/repository case, rejects credentials and unsafe numbers, and keeps different hosts distinct. GitHub Enterprise and Forgejo subpath installations require later URL-policy support. Adding a private URL shares that reference with everyone authorized to read the Lux project, so users should choose a suitably restricted project.

The next Git slice adds repository grants, verified immutable provider identity, and authorized current-state reads. It must resolve existing manual URLs into verified links without silently treating URL classification as proof. Webhook/policy rollout follows independently, then Plane automation cutover.
