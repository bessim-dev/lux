# Lux

A team project workspace built from [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio), with Convex persistence and Clerk authentication. The original Vite/vanilla JavaScript interface is retained; the backend, shared validation, and session controller use strict TypeScript.

## Run locally

Requires Node 22 or newer.

```sh
npm ci
cp .env.example .env.local
npx convex dev
npm run dev
```

Configure `VITE_CONVEX_URL` and `VITE_CLERK_PUBLISHABLE_KEY` in `.env.local`. Never put a Clerk secret key or Convex deploy key in a `VITE_*` variable.

In Clerk:

1. Enable your desired sign-in methods and require email verification.
2. Enable the Convex integration / JWT template named `convex`, with audience `convex`.
3. Include `email`, `email_verified` (a boolean), and `name` claims. The backend requires a verified email to claim invitations. Use Clerk's built-in Convex template claims, including `"email": "{{user.primary_email_address}}"` and `"email_verified": "{{user.email_verified}}"`.
4. Configure the Clerk application for your frontend domain.

Set the issuer on the Convex deployment, then deploy functions:

```sh
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://YOUR-APP.clerk.accounts.dev
npx convex dev --once
```

Sign in, create a workspace, and use **Invite member** to grant access to email addresses. Share the app URL with those people. Invitation emails are not sent by this implementation; only a matching verified email can claim membership. Owners/admins can revoke access from Members. Project sharing controls private visibility and editing permissions.

The initial Lux development deployment is `admired-giraffe-895` in the `bessim-boujebli/lux` Convex project. Its issuer is `https://prepared-mastodon-9685.clerk.accounts.dev`. Development configuration is intended for testing; use corresponding Clerk production credentials and Convex production deployment when launching the team service.

## Hosting

Build the frontend with `npm run build` and host `dist/` with the two public Vite variables configured at build time. The existing Vercel configuration is supported. Deploy the backend separately with `npx convex deploy` against the intended production project, and set its Clerk issuer. Do not point a production deployment at the test issuer below.

## Data and permissions

- Convex stores workspaces, membership, validated project/task/comment/team/view records, and file metadata. Browser localStorage only stores per-user appearance, favorites, ordering, and view preferences.
- Every public function checks an authenticated verified identity and workspace membership. Private project contents are filtered on the server. Project sharing permissions are checked for writes.
- Individual record changes are submitted transactionally with their previous values. Concurrent changes to different records survive. A stale edit to the same record is rejected; the UI offers an unsaved draft download before reloading. Edits pause briefly while a save is in flight.
- Task identifiers are assigned on the server. File contents use Convex storage, with a 25 MB per-file limit. Create a task first, then attach files from its drawer. Download URLs are bearer URLs once issued; revoking membership blocks new URL requests, not a URL already copied.
- Owner removal and ownership reassignment are blocked. Member removal revokes access and cleans project membership and assignments in one transaction.
- Private projects must retain a member who can manage access. Reassign the lead before removing the last project manager from the workspace.
- Activity descriptions are client-reported updates with server timestamps and authenticated attribution. The activity feed is not a security audit log.
- Project/task deletion cleans associated records and stored files. Full-workspace undo is disabled because replaying browser snapshots would overwrite coworkers' work.

This first team version does not send notification emails/push notifications, migrate Plane data, process billing, support public share links, or move tasks between projects. Account security is managed by Clerk. Workspace deletion is disabled. The UI's Inbox/Notifications remain empty until notification delivery is implemented. Workspace-wide subscriptions and record comparison target small teams; pagination and finer subscriptions should precede large imports.

## Integration planning

Task drawers support adding, removing, and opening GitHub and Forgejo PR URL references. Links persist separately in Convex, follow workspace/project read and edit permissions, and are removed when their task or project is deleted. A task can have up to 50 links. These are URL references: Lux does not verify PR existence, fetch provider metadata, or sync review/CI status. Use HTTPS `github.com/owner/repo/pull/number` or `forgejo-host/owner/repo/pulls/number` URLs. Forgejo subpath installations and GitHub Enterprise URLs are not supported in this slice.

The proposed shared MCP, CLI, thin Claude plugin, repository defaults, provider sync, and Plane migration are documented in [Agent access and Plane migration](docs/agent-integration-plan.md), [GitHub and Forgejo connections](docs/git-integration-plan.md), and [Research findings](docs/integration-research.md). Those integrations remain planned.

## Checks

```sh
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

`tests/backend.test.ts` exercises real Convex function handlers through `convex-test`, including authentication, invitation acceptance/revocation, private projects, stale edit rejection, and server task numbering.

For browser verification without a real Clerk account, the repository contains an explicit **local-only test harness**, not a production auth bypass:

1. Start an anonymous local Convex deployment using `CONVEX_AGENT_MODE=anonymous npx convex dev` in an isolated checkout. Preserve your hosted `.env.local` first.
2. Set that local deployment's `CLERK_JWT_ISSUER_DOMAIN` to `http://127.0.0.1:24102`.
3. Run `node tests/browser/issuer.mjs` and `npm run dev -- --host 127.0.0.1 --port 24100 --strictPort`.
4. Open `http://127.0.0.1:24100/tests/browser/index.html?user=owner`. Use `teammate` or `outsider` in separate tabs for access tests. The test emails are `<user>@example.com`.

The fixture uses signed JWTs verified by the actual local Convex backend. It is excluded from the production build and refuses non-localhost/non-development execution. Never configure the hosted deployment to trust this test issuer. Hosted Clerk login must also be checked separately.

## Source layout

- `shared/model.ts`: runtime validators and TypeScript models for the legacy data boundary.
- `convex/`: authenticated functions, membership rules, storage and schema.
- `src/cloud/session.ts`: Clerk bootstrap, Convex subscription/save lifecycle and draft recovery.
- `src/cloud/bridge.js`: adapter to the existing synchronous action/render system.
- `src/core/`, `src/actions/`, `src/pages/`, `src/views/`: original app structure.

The original author has granted free use, as confirmed by the fork owner. Original project attribution is retained here.
