# Prepare the Lux read indexes

Deploy the new Convex schema and functions to the explicitly selected Lux deployment before using the connector. Keep its existing Clerk issuer and `convex` audience configuration. The MCP setup does not deploy backend functions automatically.

Task metadata is derived from validated entity payloads. Normal browser writes update it transactionally. Existing records need a one-time backfill; search and get return `AGENT_INDEX_NOT_READY` until it finishes. Context discovery remains available so repositories can be linked first.

From an operator checkout configured for the intended deployment:

```sh
npx convex run agentIndex:status '{}'
npx convex run agentIndex:start '{}'
npx convex run agentIndex:backfill '{"cursor":null,"limit":20}'
```

For each subsequent batch, pass the exact cursor returned by the previous committed batch. Stop when `status` is `ready`. The batch limit is 1–25. Run this as operator maintenance outside model context; it is not an agent tool or an end-user credential flow.

If a response is lost or the process stops, call `agentIndex:status` and resume its committed cursor. Do not restart the migration. Concurrent starts, stale batch cursors, and restarts are rejected. An invalid stored payload aborts the entire batch without advancing the checkpoint; repair that record and resume. New writes and deletes continue to maintain the metadata while the scan runs.

These functions are internal Convex operations. The CLI uses operator access to run them; ordinary clients cannot invoke them through the public query API. No deployment key is passed to MCP clients.

The migration is validated in `tests/agent-backend.test.ts`, including legacy rows, bounded batches, interrupted checkpoint recovery, concurrent attempts, invalid-row repair, and writes during backfill. It has not been run on production data by this PR.
