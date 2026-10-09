# Plane import and GitHub issue pulls

Lux can import a bounded REOTECH Plane snapshot and manually pull GitHub issues. It is not a full Plane replacement or an automatic/two-way synchronization service.

## Destination and source safety

The public import mutation requires the current destination workspace owner, a verified identity, and project edit permission. Batches contain at most 25 records and 1 MB. Import refuses a workspace that would exceed 4,000 entities, leaving room for ordinary edits under the legacy snapshot model. Larger imports require paginated UI subscriptions first.

Source IDs are recorded by destination workspace, provider, source namespace, entity kind, and immutable source ID. Native Plane task keys and source timestamps survive import. Task counters advance above imported sequences. Source JSON remains in `importRecords` for provenance; it is not executable content. Raw snapshots contain private work data and must stay outside Git in a private directory.

Reruns update a record only while its current destination payload still equals the last imported payload. Local edits, deleted records, unmanaged ID collisions, and source identity rebinding are preserved or rejected. A conflict stops the CLI after that batch; earlier successful batches remain committed. Reuse the same reviewed plan to resume after an interrupted response. There are no source writes, source deletions, or destination deletion propagation. Restore/conflict resolution is manual; do not delete mappings to force a retry.

Members must already exist in Lux. Create/claim invitations through the normal membership flow, then explicitly map Plane user IDs to Lux member IDs in a private JSON file. The importer never fabricates identities or grants ownership. Imported projects retain the importing owner as lead/member; Plane private projects remain private.

## Plane commands

The exporter is pinned to `https://plane.reotech.org`, with explicit `reotech_internal` and `alb` workspace selection. It defaults to REOTECH. ALB must be selected with `--source-workspace alb`, never inferred from a connector's environment. It reads the API key only from `PLANE_API_KEY` in the process environment. Never put it in an argument, URL, frontend configuration, plan, or repository. The official Plane MCP can discover projects, states, and members; its modern work-item routes returned 404 on the installed CE instance during verification. `--legacy` selects the verified older `/issues/`, `/issue-attachments/`, and `/links/` routes. Reads are paced, follow cursors, and have bounded 429 retry handling. Other HTTP errors stop the export. The output file checkpoints each project and every ten items with `complete: false`; the planner rejects unfinished exports. Resume a failed read with `--resume-export /private/plane-export.json` and the same source workspace/output. Completed projects/items are reused, so a checkpoint resume is a continuing live snapshot, not an atomic source backup. Start a fresh export to capture subsequent source edits.

```sh
npm run integrations -- plane-export --source-workspace reotech_internal --legacy --out /private/plane-export.json
npm run integrations -- plane-plan --export /private/plane-export.json \
  --owner LUX_OWNER_MEMBER_ID --member-map /private/member-map.json \
  --out /private/plane-plan.json
```

Inspect the plan, counts, and warnings before applying:

```sh
npm run integrations -- apply --plan /private/plane-plan.json --apply \
  --instance https://YOUR-DEPLOYMENT.convex.cloud --workspace WORKSPACE_ID \
  --credential-file /private/lux-credential.json
```

Use the existing short-lived Clerk JWT credential format in [MCP setup](mcp-setup.md). A credential must match the requested instance. Normal browser identity and authorization apply. Deployment/admin keys are not user credentials.

The slice imports projects, active endpoint work items, comments with mapped authors, labels, dates, descriptions as plain text, single assignees, and supported PR URL references. It retains rich descriptions/source fields in provenance. Custom workflow names are retained as `Imported state:` labels; started stages named review/validation map to Lux Review, and other groups map to their native equivalent. This does not reconstruct a custom workflow state machine. Cycles, modules, pages, custom fields, estimates, additional assignees, parent/dependency relationships, reactions, generic links, are not reconstructed as native Lux features. Available cycles/modules/links/attachment metadata stay in the export. Attachment bytes up to 25 MB can be copied in the separate file step below. Archived-item and workspace-page inventory is not established by this exporter. Warnings describe encountered representational losses; absence of a warning does not prove full migration coverage.

## Plane attachment bytes

After importing the core records, copy attachment bytes through the same native upload validation used by the web app:

```sh
npm run integrations -- plane-files --export /private/plane-export.json --apply \
  --owner LUX_OWNER_MEMBER_ID --workspace WORKSPACE_ID \
  --instance https://YOUR-DEPLOYMENT.convex.cloud --credential-file /private/lux-credential.json
```

`PLANE_API_KEY` stays in the environment. It is sent only to Plane's attachment-detail endpoint. The presigned redirect is fetched without Plane credentials. Downloads are bounded at 25 MB and compared with source sizes. Convex verifies the uploaded checksum and commits the file plus source mapping in one transaction; a download checksum verifies the finished copy. Retries skip intact mapped files and reject local changes/deletions. Unavailable source uploads and files over 25 MB are reported as skipped. File metadata records the actual importer and transfer time; source authors/timestamps remain in provenance. A failed upload before attachment can leave an unattached storage blob; no destination file is duplicated, and source data remains intact.

## GitHub commands

Set a project's GitHub repository URL in Project settings. It is a project reference, not an OAuth grant. Authenticate `gh` with an account allowed to read that repository. The command verifies the repository's canonical URL and records its immutable repository ID in the source namespace, follows all issue pages, and excludes pull requests from the issue list.

```sh
npm run integrations -- github-plan --repository https://github.com/OWNER/REPO \
  --project LUX_PROJECT_ID --project-key LUX --out /private/github-plan.json
npm run integrations -- apply --plan /private/github-plan.json --apply \
  --instance https://YOUR-DEPLOYMENT.convex.cloud --workspace WORKSPACE_ID \
  --credential-file /private/lux-credential.json
```

Issue numbers become native task sequences, so use an empty dedicated project or review key collisions first. Open issues become Todo and closed issues become Done. Bodies, labels, source timestamps, and issue URLs are copied. Assignees remain unassigned; provider account metadata is retained in provenance. Issue comments and PR/CI/review metadata are not synchronized. Repeat export/plan/apply to pull changes; locally edited imported tasks report conflicts. No hosted provider token, GitHub App, webhook, schedule, or push-to-GitHub behavior is activated.

The separate `pgf-sync-engine` remains the Git-event policy worker. This manual issue mirror does not run a competing PR lifecycle policy. Automatic integration still needs a typed Lux destination, repository grants, durable ingestion/effects, recovery, and explicit field ownership.

## Production deployment

The frontend and Convex functions deploy independently. A successful Cloudflare Pages build does not update Convex. Use an explicit verified production environment file when deploying, preserve the production Clerk issuer, inspect the dry-run, and back up/export the destination before data transfer. Do not reuse `.env.local` from a local test deployment.

After first deploying the indexed APIs, call the internal `agentIndex.start` once, then `agentIndex.backfill` with each returned cursor until ready. Recover a checkpoint with `agentIndex.status` instead of restarting. See [MCP validation](mcp-validation.md).
