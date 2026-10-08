# Shared MCP foundation

Lux is the first application for a reusable TypeScript MCP package. Application adapters own their tools and permissions. The shared package owns the small transport, result, error, and binding contracts that other applications can reuse.

## First implementation

- `@reotech/mcp-kit` wraps the official TypeScript SDK. It does not implement another protocol or authorization server.
- Lux exposes `lux_context`, `lux_search`, and `lux_get`. Search returns task summaries. Descriptions require an explicit request. Existing GitHub and Forgejo PR references are readable through task retrieval.
- Convex remains authoritative for verified identity, current workspace membership, and project visibility on every query.
- Local connections pin an instance, workspace, and project through a versioned repository binding. The binding contains no credential and grants no permission.
- A separate Document API example wraps its existing country-pack readiness endpoint to exercise the same package with a different backend and authentication mechanism.

The initial local Lux connector uses the user's short-lived Clerk JWT for the existing Convex audience. It is an incremental connector, not a completed browser login or hosted OAuth integration. Expired credentials must be renewed through the existing trusted authentication flow.

The shared HTTP handler requires a host-supplied authorization implementation. Protocol tests using a test verifier demonstrate request isolation and transport behavior. They do not prove production Clerk login, token exchange, or ContextForge integration.

## Authentication boundary

An OAuth token issued for an MCP resource cannot simply be forwarded to Convex as its `convex` audience JWT. Before enabling hosted Lux, prove the issuer, resource/audience, subject, verified email, expiry, scopes, and current grants. Browser and agent requests must resolve to the same Lux member. Never use a deployment key as an end-user credential or accept a caller-supplied principal as authority.

Credentials are configured separately from repository bindings. Compare the binding's destination with the credential profile's trusted instance before making a request. Repositories must not redirect an existing credential to another service. Concurrent processes keep independent bindings, and each backend call checks current access.

## Gateway reuse

Evaluate IBM ContextForge as the shared registry and proxy for selected application catalogs. Keep direct application MCP connections available. Reuse its routing and operational controls instead of building a custom fleet gateway.

The candidate release is [ContextForge 1.0.11](https://github.com/IBM/mcp-context-forge/releases/tag/v1.0.11), checked on 2026-10-08. Its release notes describe per-caller OAuth status, private catalog registration, and configurable modern protocol negotiation. Installation and configuration still require an actual direct-versus-proxied compatibility test. A gateway login does not grant access to private Lux projects.

Use per-user downstream credentials where the application requires user permissions. Document API's explicitly configured API key is a service credential; its example does not claim to provide individual-user authorization.

## Dependencies and alternatives

The official [TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) is the stable split-package release line. The implementation must use the installed package APIs and test negotiated protocol behavior. Clerk helper packages that depend on SDK v1 require a separate compatibility assessment.

`convex-mcp-gateway` is not a drop-in replacement for Lux's native authentication helper. Its component dispatch propagates an identity argument rather than preserving native `ctx.auth`. See the [pinned identity propagation design](https://github.com/tfohlmeister/convex-mcp-gateway/blob/094d38747b5d874b837cd3e07701466aff81a30a/docs/architecture.md#identity-propagation). Adopting it would require a carefully authenticated internal adapter and permission tests.

## Subsequent work

1. Prove production Clerk identity mapping and hosted resource authorization, then test ContextForge with two users, selected catalogs, refresh, and revocation.
2. Add secure login and credential renewal to the CLI, with an OS credential-store integration.
3. Add focused task mutations with server audit, expected versions, and idempotency.
4. Add provider grants and GitHub/Forgejo status synchronization.
5. Implement the resumable Plane importer and staging reconciliation described in the [agent integration plan](agent-integration-plan.md).

Production deployment, write tools, provider synchronization, and Plane data transfer are separate gates. This foundation establishes the read contracts and reusable package needed for them.
