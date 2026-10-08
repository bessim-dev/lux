# Document API reuse example

This is a second integration of `@reotech/mcp-kit`, alongside Lux. It is an example adapter, not a deployed service or the full Document API product. It registers only `document_country_pack_readiness`, a read-only call to the existing `GET /v1/knowledge/country-packs/:jurisdiction/:version/readiness` route.

An operator supplies the application origin and a `getApiKey` provider when calling `createDocumentServer`. Resolve the Document API key on every request so rotation does not require a server restart. Use HTTPS. HTTP needs `allowLoopbackHttp: true` and a loopback IP literal. URLs containing credentials, query parameters, fragments or a path are rejected. The tool accepts only a jurisdiction and version; clients cannot choose destinations, credentials, headers or tenants.

The key is a manually configured automation identity accepted by Document API's `apiKeyAuth('document')`. This adapter does not authenticate individual users or provide user-specific authorization. The operator must protect the MCP transport and use an appropriately restricted Document API key. The factory leaves transport ownership to its caller and makes no changes to global MCP configuration.

The adapter rejects redirects, limits each request to five seconds and reads at most 128 KiB of response data. It validates the exact readiness response and returns at most 20 blocker codes, counts by readiness state, and at most 20 source keys and states. It omits document and reviewer identifiers. The result includes omitted counts, field names and the underlying detail route. The API has no pagination for this route, so `continuation` is null. Consult the application using that route when full source details are needed.

The checked-in HTTP fixture was derived from the local Document API source inspected on 2026-10-08:

- `src/routes/knowledge.ts:61-81` defines the route, its identity patterns and raw JSON response.
- `src/features/country-packs/readiness.ts`, `evaluateCountryPackReadiness`, `missingSource`, and `sourceReadiness` evaluates readiness and constructs its source records.
- `src/services/auth.ts:9-21` accepts the configured Document API key through `x-api-key` or authorization.

Tests do not import that separate checkout. They initialize an SDK client over in-memory MCP transports and exercise a local HTTP fixture for the existing route, authentication, validation, response bounds and safe errors.
