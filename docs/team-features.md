# Team features and notification setup

Lux stores shared work in Convex. Project lists, boards, calendars, timelines,
files, saved views, comments, teams, and member settings use the existing entity
and membership APIs. Appearance, favorites, and view ordering remain per-user
browser preferences. Clerk manages account security.

## Notifications

Assignments, comments, exact `@Name` mentions, and project/task updates appear in
Inbox and Notifications. Assignment and update recipients must follow the project
or be its task assignee, and must currently have read access. Mentions can reach
any active member with read access. Members control the four in-app event classes.
Email and mobile push are not implemented by the current shared engine.

The schema uses separate tables for separate lifecycles:

| Table                     | Purpose and indexes                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notificationEvents`      | Server-validated before/after entity changes, actor ID/name, and membership pagination cursor. `by_workspace` supports deletion.                                                            |
| `notifications`           | One recipient's event, content, source IDs, `readAt: number \| null`, and dedupe key. Recipient/time, recipient/unread/time, workspace/recipient/dedupe, and workspace indexes.             |
| `notificationPreferences` | Workspace/member event and delivery flags. `by_member_workspace`. Email/push flags are reserved and default false.                                                                          |
| `notificationOutbox`      | Notification ID, idempotency key, delivery state, attempts, next attempt time, schedule token, and safe error category. Workspace, workspace/status, notification, and status/time indexes. |

`entities.apply` atomically enqueues relevant `notificationEvents`; it does not
fan out inside the editing transaction. Each internal dispatch processes 25
membership rows, checks current project/task access, deduplicates notifications,
and inserts their outbox rows in the same transaction. Completion advances the
cursor and schedules the next batch, or deletes the job. Rapid reassignment does
not send an obsolete assignment to the previous assignee.

The inbox uses native cursor pagination with a bounded page size. List queries
recheck source visibility, including deleted or moved tasks. Read status is
recipient-owned. Mark-all processes bounded batches using one cutoff time, so new
arrivals remain unread. Frontend subscription tokens discard late page callbacks.

## Shared notification engine

The delivery adapter implements the contract in
[REOTECH/notifications](https://git.reotech.org/REOTECH/notifications), locally
available as `reotech-notifications`. Configure these **server-only Convex** values
for the intended deployment:

```text
REOTECH_NOTIFICATIONS_URL=<notification API origin>
REOTECH_NOTIFICATIONS_SERVICE_KEY=<trusted Lux producer key>
```

Register that producer key in the engine's `SERVICE_AUTH_KEYS` map. Use the
deployment's secret manager or Convex environment settings; do not put the key in
Vite variables or source control. Lux sends authenticated `POST /v1/events` calls
with tenant `lux:<workspace ID>`, subject `member:<member ID>`, and stable
`externalEventId`. Payload data contains typed source IDs, never arbitrary action
URLs. UTF-8 title/body lengths follow the engine's limits.

The outbox is retained when configuration is missing. Settings displays delivery
configuration and bounded state counts; owners/admins can retry eligible queued
events after setup. API-only admin inspection supports paginated pending/failed
queues. Delivery uses a five-second timeout, at most five automatic attempts,
exponential backoff, a 30-second recovery lease, and rotating schedule tokens.
Stale callbacks cannot claim or complete a newer attempt. Errors expose only
timeout, network, or HTTP status categories. Recipient membership and current
project/task access are checked before sending.

The shared engine has its own inbox/read state. Lux read/unread state belongs to
Convex and is not synchronized with the engine's read state. No email or mobile
push provider is implied by successful delivery to the shared inbox.

## Workspace and storage lifecycle

`workspaces.lifecycle` is optional `deleting`. Deletion requires the authenticated
owner and the exact current workspace name. One mutation sets the lifecycle and
schedules cleanup. Access, workspace lists, and snapshots hide/reject deletion in
progress. Each cleanup batch takes at most 50 rows from a workspace-indexed table,
including events, inbox rows, preferences, outbox, uploads, entities, counters,
PR links, import provenance records, and memberships. Upload storage is removed only after its last upload
reference disappears. The workspace row is removed after its tables are empty.
No separate cleanup cursor/job table is needed because each batch deletes the
first remaining indexed page.

File duplication uses an action to copy storage bytes, then an internal mutation
rechecks source, task/project access, and storage ownership before publishing a
fresh metadata ID and uploads row. The copy is invisible until finalization and
survives deletion of the original file. No upload clone fields are added.

Task moves require edit access to both projects. Destination keys are allocated
transactionally, with indexed collision checks for stale counters. Attached file
metadata and up to 50 PR links move with the task. Excess legacy links cause a
clear failure rather than a partial move. Subtask assignee, due date, and note
fields survive saves.

## Current scale boundaries

New notification fanout, history, delivery inspection, and workspace cleanup use
bounded batches and indexed pagination. Normal entity edits load referenced
records rather than every workspace entity. The existing JSON entity model and
full workspace snapshot remain a limit: the overview allows 5,000 records, entity
edits allow 500 members, project catalog edits allow 500 projects, and counter
bootstrap/collision repair allows 1,000 rows. Before the existing `tasks-v1` index
backfill is ready, key allocation checks up to 1,000 workspace tasks, including
rows missing derived metadata. Operators can resume `internal.agentIndex.start`
and `internal.agentIndex.backfill` using the existing checkpoint API. Deletion and task moves still use the
bounded legacy graph. These explicit guards do not make large imports supported.

Membership edits, workspace settings, and entity edits are separate frontend
mutations. A later failure can leave earlier changes saved; the UI preserves the
remaining draft and offers reload/download recovery. Entity batches themselves
are transactional. A future unified save API or explicit reconciliation flow is
needed to make a mixed membership/project save atomic.

This implementation follows Convex guidance on
[indexed queries and bounded reads](https://docs.convex.dev/understanding/best-practices),
[native pagination](https://docs.convex.dev/database/pagination), and
[actions for external effects](https://docs.convex.dev/functions/actions).

## Verification

Unit/integration tests cover authorization, private-project revocation, recipient
preferences, server event hooks, 500-member deferred fanout, cursor isolation,
mark-all batching, outbox dedupe/leases/retries, safe admin inspection, workspace
cleanup, storage cloning, and task moves. A local real Convex backend and real
notification engine also verified event delivery and byte-preserving duplication
after original deletion. Local signed test identities never replace production
Clerk configuration.
