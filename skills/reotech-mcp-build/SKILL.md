---
name: reotech-mcp-build
description: Implement an application MCP adapter using the shared Reotech TypeScript kit built for Lux, with pinned repository context, bounded tools and native application permissions. Use for new app connectors or extending existing ones.
---

# Build an application MCP

Use the application-neutral `@reotech/mcp-kit` from Lux rather than copying its transport implementation. Keep application contracts and permissions in the target application. The same tool definitions should serve Claude, Codex and other MCP clients; plugins add configuration and short workflow guidance.

Read [the adapter guide](references/adapter-guide.md) for package acquisition, the typed factory example, source references and verification cases. Read only the relevant sections after choosing the integration mode.

## Establish the real starting point

Locate the target application's existing API, authorization helpers and tests. Consult `~/Codes/PROJECTS.md` if available when a related local service is involved. A locally available real API takes precedence over inventing a fixture contract.

Find Lux through the project catalog or a supplied checkout. The kit is at `packages/mcp-kit`; inspect its actual exports, installed dependencies and the existing `agent/` and `examples/document-api/` adapters. If the kit is absent, use the pinned source and packaging instructions in the guide. It is not yet a published registry package. Preserve the target's package manager and lockfile. For a different backend runtime, a separate Node 22 adapter can call its existing API; do not assume Bun or another runtime is compatible with the kit.

The reference is the read-only foundation in [Lux PR #3](https://github.com/bessim-dev/lux/pull/3). Verify its current state before assuming the default branch contains it. The kit requires Node 22 or newer. Verify current package compatibility before adding auth helpers that may depend on another MCP SDK major version.

Select the requested mode:

- Local stdio uses a private credential provider and explicit trusted service configuration. Use a repository binding pinned at process startup when calls need repository-specific defaults.
- Hosted Streamable HTTP uses a real request verifier and application authorization. The shared handler provides hooks, not an OAuth issuer or token exchange.
- A shared gateway adds catalog selection and routing after direct app calls work. ContextForge was evaluated, not deployed. No shared gateway URL or public Lux MCP endpoint exists in this reference. Inspect current infrastructure when deployment is requested.

## Build the adapter

1. Choose a small, stable set of application operations. Lux's context/search/get split is a useful starting point, not a mandatory tool count. Prefer indexed filtered summaries and explicit detail reads. Avoid generic arbitrary-URL or database-execution tools.
2. Define strict Zod inputs and outputs and typed `defineTool` handlers. Use `createMcpServer`, `serveMcpOverStdio` or `createStreamableHttpHandler` for the needed transport. Keep descriptions short and annotations accurate.
3. Configure a trusted instance. If the application has repository-specific workspace/project scope, pin its immutable identifiers in a versioned nonsecret binding. Resolve the closest valid binding up to the Git root; reject an invalid closest file. Require an explicit absolute project directory when MCP startup discovers a repository binding. Local CLI discovery can use cwd. For a global API, an operator-configured origin may suffice; do not invent tenancy or project IDs.
4. Resolve credentials on every call. Compare the binding destination with the credential profile's trusted destination before sending a credential. Explicit scope overrides still require backend permission checks. Bindings, tool inputs and gateway login never grant application permissions.
5. Reuse native verified identity and current membership/project checks where the application supports them, on every backend call. A resource OAuth token is not automatically valid for another backend audience. Do not invent caller-supplied principal authority or use deployment/admin credentials as user credentials. If using a service key, inspect the other routes it authorizes and state its actual privilege and lack of individual-user authorization. Read-only tool annotations do not restrict the credential.
6. Add finite upstream deadlines, cancellation, input/response byte limits and safe errors. Keep stdout exclusively for stdio protocol. Use explicit pagination, omission counts or truncation flags; do not silently discard data to satisfy the kit's result limit.

Start with the operations the user requested. New writes need native authorization, concurrency protection and appropriate audit/idempotency behavior. A connector task does not implicitly authorize a production migration or deployment.

## Verify and hand off

Use the target project's checks and actual MCP client calls. Test isolation between simultaneous users/workspaces, access revocation, wrong destinations/audiences, pagination scope, expired or rotated credentials, deadlines and cancellation as applicable. Test real host startup and the declared schema, not just direct handler functions.

Report fixtures separately from real authentication and deployments. Catalog bytes and result bytes are useful budgets; they do not prove token savings. A validated plugin config does not prove a complete host workflow.

Document package revision, chosen tools, binding schema, credential setup/rotation, index migration if required, host commands and remaining deployment/auth gaps. Follow the target project's Git/PR and evidence workflow. Do not change global host configuration, publish a package or deploy infrastructure merely because this skill describes those options.
