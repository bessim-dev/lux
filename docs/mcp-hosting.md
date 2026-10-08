# MCP hosting decision

Hermes Ops inspected the current Reotech runtime on 2026-10-08 without deploying or changing configuration. The detailed infrastructure report and accounting are retained privately outside this repository. This document records the deployment implications without publishing internal addresses or credentials.

## Application adapters

Use the existing Coolify host for small stateless TypeScript MCP services. Ops verified an ARM64 Docker runtime, a healthy Coolify proxy, and existing application routing through the HTTPS gateway. Select ARM64-compatible Node images and dependencies.

Ordinary application HTTPS worked during inspection. MCP initialization, protocol negotiation, streaming, reconnects, session headers, OAuth discovery, and forwarded HTTPS still need tests through the exact public route. Wildcard DNS does not create a gateway route by itself.

Lux's local connector can be used independently while hosted user authentication is completed. There is no public Lux MCP endpoint in this foundation.

## Shared gateway

Evaluate [ContextForge 1.0.11](https://github.com/IBM/mcp-context-forge/releases/tag/v1.0.11) on an AMD64 target. The [release README](https://github.com/IBM/mcp-context-forge/blob/v1.0.11/README.md#quick-start---containers) explicitly excludes ARM64 production support for the supplied container setup. The existing ARM64 Coolify host is therefore not the production default for this gateway.

Ops found an AMD64 host with Docker and available capacity, but it also hosts CI workers. A dedicated AMD64 application VM is preferable for a shared gateway that stores downstream credentials. That VM has not been provisioned or reserved. The supported management path, route, resource limits, and operational owner must be established before deployment.

Reuse ContextForge's registry, selected virtual-server catalogs, and upstream connection controls. Test direct versus proxied calls and both current and legacy client protocol negotiation with the pinned release. Do not expose every application's complete catalog by default.

## Persistence and identity

Ops verified a reachable PostgreSQL listener, durable existing container volumes, and object storage. Database authentication, a dedicated role/database, recovery coverage, and native backup policy for this workload remain unverified. Provision dedicated persistence and credentials; existing platform databases are not implicitly available for reuse.

Preserve ContextForge signing and credential-encryption material alongside its database and verify a restore. Keep application credentials separate from Coolify platform credentials.

No shared identity provider was established in the inspected inventory and gateway route configuration. Keep existing application authentication until a separate identity policy is chosen. ContextForge authentication adds a gateway boundary; it does not replace current Lux membership and project authorization.

Ops could not verify Lux's deployed Clerk and Convex settings. Hosted Lux must remain disabled until its actual issuer/resource/audience mapping and browser-member equivalence pass. Include wrong-audience, expired-token, revoked-member, private-project, and simultaneous-workspace cases.

## Inspection limit

A read-only Coolify administrative API command timed out while awaiting harness approval. Ops did not retry or bypass it. Runtime hosting evidence is available, but configured deployment destinations and native backup policies were not verified through the control plane. Resolve those facts during the deployment task before claiming a production-ready hosting configuration.
