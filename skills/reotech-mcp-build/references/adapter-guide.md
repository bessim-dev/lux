# Reusing the Lux MCP foundation

This guide is for implementing an MCP in another application. It describes the code built for Lux on 2026-10-08, not a managed service or a completed fleet deployment.

## What to reuse

| Layer                  | Reuse                                                         | Application responsibility                                                 |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Protocol and transport | `@reotech/mcp-kit`, backed by official MCP SDK v2             | Hosting runtime and supported client checks                                |
| Tool contracts         | `defineTool`, Zod validation, structured results, safe errors | Schemas, tool behavior, permission checks and bounded data                 |
| Repository context     | Binding discovery, private-file reader, origin parser         | App binding schema, trusted credential profile and defaults                |
| HTTP identity          | Stateless request isolation, expiry/resource/scope checks     | Signature and issuer verification, real token flow and native user mapping |
| Fleet routing          | Evaluate ContextForge registry and selected catalogs          | Deployment, downstream credentials, app permissions and recovery           |
| Host integration       | Same MCP endpoint or stdio process                            | Thin Claude plugin or each host's MCP configuration                        |

There is no deployed shared gateway or public hosted Lux MCP endpoint from this work. The reusable deliverable is a package and adapter pattern. Each application gets its own MCP adapter. ContextForge may later proxy selected app catalogs through a shared gateway.

## Acquire the shared package

The known working source is [Lux commit `8f424084`](https://github.com/bessim-dev/lux/tree/8f424084a65ec3ed394a35742265a9ae56b3178d). [PR #3](https://github.com/bessim-dev/lux/pull/3) tracks its merge state. Use a supplied, clean checkout containing `packages/mcp-kit`, or fetch the pinned commit into a separate checkout. Do not switch another agent's active checkout.

The package is version `0.0.1`, currently unpublished and marked `UNLICENSED`. Internal reuse here does not authorize public package publication. Node 22 or newer is required. The known lockfile uses split SDK v2 packages; keep it when reproducing the reference. New dependency upgrades require compatibility checks.

For another npm project, build and pack the kit in the source checkout, then install the resulting tarball in the target:

```sh
# In the clean Lux checkout containing the kit, using Node >=22.
npm ci
npm run mcp:kit:build
mkdir -p /tmp/reotech-mcp-kit
npm pack --workspace @reotech/mcp-kit --pack-destination /tmp/reotech-mcp-kit

# In the target application, use the emitted filename.
npm install /tmp/reotech-mcp-kit/reotech-mcp-kit-0.0.1.tgz
```

Build precedes packing because the package exports `dist`. Do not tell agents to `npm install @reotech/mcp-kit` from a registry that has no published release. A temporary tarball path is suitable for an experiment, not clean CI installs. For a committed dependency, place the reviewed tarball at a stable project artifact path or use an explicitly configured internal package registry. Record its source commit and hash and commit the consumer lockfile. Do not silently publish to a registry.

These are npm-project commands. Preserve another target's existing package manager and lockfile; use its supported local-artifact mechanism instead of adding a competing npm lockfile. If the target already has a monorepo package workflow, add the kit through that workflow with provenance. Keep one maintained kit source; avoid copying individual transport files into each app. TypeScript examples also require Zod 4 in the consuming project's dependencies.

The backend and connector need not share a runtime. The inspected Document API uses Bun. A separate Node 22 connector calling its existing HTTP API avoids changing that backend or claiming untested Bun compatibility. Embedding the kit in another runtime needs explicit compatibility tests first.

## A typed server factory

This factory demonstrates the kit API. `readSummary` and `resolveContext` are the application's trusted dependencies, not generated permission bypasses. `readSummary` must enforce the caller's current access. Keep real application I/O outside protocol glue.

```ts
import { createMcpServer, defineTool, type CallInfo } from '@reotech/mcp-kit';
import { z } from 'zod';

const inputSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const outputSchema = z
  .object({
    id: z.string(),
    title: z.string().max(200),
  })
  .strict();

interface AdapterContext {
  userId: string;
  workspaceId: string;
}

interface AdapterDependencies {
  resolveContext(call: CallInfo): Promise<AdapterContext>;
  readSummary(context: AdapterContext, id: string, signal: AbortSignal): Promise<z.input<typeof outputSchema>>;
}

export function createApplicationServer(deps: AdapterDependencies) {
  const get = defineTool({
    name: 'app_get',
    title: 'Get record',
    description: 'Read a record summary in the connected workspace.',
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run(input, context: AdapterContext, call) {
      return deps.readSummary(context, input.id, call.signal);
    },
  });

  return createMcpServer({
    name: 'application',
    version: '0.0.1',
    tools: [get],
    resolveContext: deps.resolveContext,
  });
}
```

This is a server factory, not a runnable transport or completed app adapter. `serveMcpOverStdio` accepts the same server specification, not the factory's returned server instance. `createStreamableHttpHandler` accepts a specification with `authenticate`, optional `authorize`, and `resolveContext(caller, call)`. Its `fetch(Request)` still needs a host HTTP runtime. Inspect these exported types before wiring transport.

For Lux's fuller context/search/get contracts, use [agent/tools.ts](https://github.com/bessim-dev/lux/blob/8f424084a65ec3ed394a35742265a9ae56b3178d/agent/tools.ts). For an existing service-key API, use [the Document API factory](https://github.com/bessim-dev/lux/blob/8f424084a65ec3ed394a35742265a9ae56b3178d/examples/document-api/server.ts) and [bounded reader](https://github.com/bessim-dev/lux/blob/8f424084a65ec3ed394a35742265a9ae56b3178d/examples/document-api/readiness.ts).

## Scope and credentials

Use immutable IDs in a versioned nonsecret binding when the application has workspace/project scope. Choose an app-specific filename such as `.lux.json`; preserve an existing app convention when available. A binding selects defaults, and the backend verifies access to those defaults. A global API such as Document API readiness has no workspace/project fields; operator-configured service origin and credential may suffice. Do not add fictional tenant IDs to make it look like Lux.

Lux's binding is `{version: 1, instance, workspace?, project?}`. Pin it once per MCP process from an explicit absolute project directory or a host-provided project directory. Do not depend on a GUI client's cwd. The closest binding up to the Git root wins, including linked Git worktrees. An invalid closest binding fails rather than falling back to a different workspace.

Resolve credentials independently on every tool call. A trusted credential profile owns its allowed instance. Reject a binding/credential instance mismatch before the request. A tool argument must not choose the credential destination, arbitrary headers or principal. Explicit workspace/project overrides remain subject to backend authorization. The project default only carries forward when its workspace matches.

`readPrivateFile` rejects symlinks, nonregular files, wrong ownership and broad permissions. It checks the opened descriptor too, including FIFO cases. The current private-file implementation is Unix-oriented and unsupported on Windows; choose an appropriate credential-store adapter there. Tokens do not belong in repository files, tool output, stdout, task prompts or logs.

Lux's local credential is a short-lived native Clerk JWT for Convex's `convex` audience. Renewal is manual. That JWT still has the user's native privileges even though the connector exposes only reads. An unsigned JWT-shaped test token proves no production authentication.

Hosted HTTP needs an actual verifier for signature, issuer, audience/resource and expiry. Return a `VerifiedIdentity` only after verification. The kit's expiry/resource/scopes checks do not perform that verification for you. Current application grants must still apply per call, including revocation.

An OAuth MCP resource token cannot simply be forwarded as a Convex JWT with another audience. Prove the browser and MCP identity resolve to the same native member before enabling hosted Lux. Avoid accepting identity arguments as trusted replacements for `ctx.auth`.

The Document API example uses an operator-configured automation key and does not provide per-user authorization. Its existing `document` key also authorizes document uploads. Read-only MCP tools do not restrict that key's native privilege. A claim of read-only credentials requires a backend grant that actually limits routes or operations. Discover the application's secret-provider conventions and document operator setup when none exists; do not hardcode an endpoint or key.

## Keep context and I/O bounded

- Use a stable small catalog with short tool descriptions. Put workflow explanations in an optional skill or docs instead of every tool's description.
- Return typed summaries with immutable IDs and cursors. Fetch descriptions, attachments or history only when requested. The kit's default structured result budget is 32 KiB; oversize results fail explicitly. The text compatibility copy also contributes to client context.
- Apply pagination and limits in the backend query. Fetching an entire workspace and trimming it in MCP still creates load and risks exposure. Scope cursors to identity, selection and filters; avoid embedding private identifiers or credentials.
- Bound each upstream operation, including credential acquisition where asynchronous, response bodies and redirects. Propagate `call.signal` and combine it with a finite deadline. Lux uses 15 seconds; the Document API example uses five seconds and a 128 KiB upstream response bound. Choose limits for the actual operation.
- Never log to stdout for stdio. Npm lifecycle banners also corrupt protocol startup; use direct launchers or silent build commands.
- A safe `ToolError` needs a stable code and useful recovery hint. The kit redacts unexpected errors, but upstream clients and host logging also need safe configuration.
- HTTP requires explicit Host/Origin allowlists and body limits. This kit's Origin allowlist compares hostnames, not scheme or port. If the deployment requires an exact origin policy, enforce it in the host before passing to the kit. Test reverse-proxy headers and resource URLs through the actual public route.

Catalog character limits and byte budgets do not demonstrate model token savings. Measure the actual host catalog and representative results before making that claim.

## Verification that caught real defects

Use existing project tests and SDK clients rather than introducing a parallel framework. Relevant reference tests are `tests/mcp-kit.test.ts`, `tests/mcp-binding.test.ts`, `tests/mcp-lux.test.ts`, `tests/mcp-stdio.test.ts` and `tests/document-mcp.test.ts` in the pinned Lux checkout.

| Behavior               | Meaningful check                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Contract and transport | Initialize a real SDK client, list tools, call with declared input, inspect structured output and safe errors     |
| Pinned defaults        | Run from two repository/worktree directories; omit scope arguments; verify each backend receives its own IDs      |
| Native permissions     | Two users, a private project, removed membership, wrong workspace and caller-supplied identity attempts           |
| Credential boundaries  | Wrong instance fails before network; expired credential fails; rotated credential works without restart           |
| Files and discovery    | Invalid closest binding, Git root boundary, symlink, permissive mode, oversized file and FIFO that exits promptly |
| Bounded data           | Large result, explicit description request, pagination/filter changes and scoped cursor reuse rejection           |
| Upstream failures      | Stalled response body, deadline and cancellation, including actual socket release                                 |
| HTTP isolation         | Concurrent callers, bad resource/scopes, malformed verifier identity and throwing authorization hooks             |
| Host startup           | Actual Claude/Codex process with clean protocol stdout and no scope IDs on ordinary calls                         |
| Plugin workflow        | Plugin connects once, intended catalog/skill loads and a full tool sequence completes                             |

Fixture protocol tests, a deployed backend and real host authentication are separate evidence. The Lux reference passed automated tests and a final Codex three-tool fixture smoke. The final Claude plugin connected and read context, but its full scripted sequence did not complete. Use these as specific limits, not blanket claims that all hosts are production-ready.

## Hosting and fleet reuse

For a local connector, ship a direct executable and host configuration. The Claude plugin is thin; other clients connect to the same process or authenticated HTTP endpoint. Do not duplicate tool implementations per client or silently change global MCP configuration.

For hosted services, inspect current infrastructure before deploying. Reotech's 2026-10-08 inspection found an ARM64 Coolify runtime suitable for Node adapters. ContextForge 1.0.11's evaluated production container setup excluded ARM64; a dedicated AMD64 application target was recommended but not provisioned. PostgreSQL authentication, dedicated persistence, native backup policy and recovery were not verified for this workload. Recheck release support and actual resources when implementing deployment.

Keep direct app endpoints usable. Evaluate ContextForge for registry, selected virtual catalogs and proxying rather than building those fleet controls into the kit. A gateway login does not grant app access. Test direct versus proxied tool calls, per-user downstream credentials, refresh/revocation, streaming, protocol negotiation and exact public routing. No registry URL or deployment command can be assumed from this guide.

The pinned [hosting findings](https://github.com/bessim-dev/lux/blob/8f424084a65ec3ed394a35742265a9ae56b3178d/docs/mcp-hosting.md) and [authentication design](https://github.com/bessim-dev/lux/blob/8f424084a65ec3ed394a35742265a9ae56b3178d/docs/shared-mcp-foundation.md) contain the remaining gates. Real infrastructure work uses the environment's authorized Ops workflow when available.

## Deliverable for the next app

Leave a working adapter, focused tests, reproducible host commands, dependency provenance, binding/credential instructions and a clear list of unverified auth/deployment steps. Use the project's PR workflow. Add migrations only where required for bounded backend reads; Lux's internal index backfill is specific to its existing entity storage, not a generic MCP requirement.

If adding writes, define native grants, expected versions or concurrency semantics, retry/idempotency behavior and audit attribution before exposing them. Plane migration and Git provider synchronization remain separate application features.
