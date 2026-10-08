# @reotech/mcp-kit

Small, application-neutral helpers around the official MCP TypeScript SDK (`@modelcontextprotocol/server` v2). It adds no protocol, OAuth server, cache or gateway.

- `defineTool` / `createMcpServer`: typed tools with Zod input and output schemas, accurate annotations, validated `structuredContent` plus a compact JSON text copy, a result size budget (never silent truncation) and safe errors (`ToolError` is returned; anything else becomes a generic reference and is logged redacted).
- `createStreamableHttpHandler`: a stateless Streamable HTTP endpoint (`fetch(Request) => Response`). The host supplies `authenticate` (it must already verify signature, issuer, audience and expiry). The kit refuses a missing, expired or wrong-resource identity and missing scopes, validates `Host` and `Origin` against required allowlists, bounds the body, and serves each request from a fresh server bound to that caller.
- `serveMcpOverStdio`: the same tools over stdio. Context is resolved per call.
- `discoverBinding` / `writeBinding` / `resolveProjectDir`: immutable, versioned, non-secret binding files found between a verified directory and the Git root. The closest file wins; an invalid one is an error.
- `readPrivateFile`: reads a secret file only if it is a regular, owner-only, non-symlink file owned by the current user.
- `parseServiceOrigin`: https-only origin parsing (loopback http only on explicit request).

Requires Node 22 or newer. Bundlers and tests in this repository import it by package name through an npm workspace; run `npm run mcp:kit:build` first (the `pretest` and `pretypecheck` scripts do).
