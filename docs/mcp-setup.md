# Lux local MCP and CLI setup

Status: first local slice. Read-only. There is **no hosted Lux MCP endpoint** and no browser login in this release. It runs on your machine, as you, with a short-lived token you supply. See [shared MCP foundation](shared-mcp-foundation.md) for the design and [MCP hosting](mcp-hosting.md) for why hosted access is blocked.

Requires Node.js 22 or newer. Node 22 (`.nvmrc`) is what CI uses.

Deploy the backend functions and complete the [one-time read-index backfill](mcp-index-migration.md) on the intended deployment. This checkout does not deploy or migrate production data automatically.

## Install from a checkout

```sh
nvm use                      # Node 22
npm ci
npm run agent:build          # builds @reotech/mcp-kit, then bundles agent/main.ts into agent/dist/lux.mjs
npm link                     # puts `lux` on your PATH (root package "bin")
lux --help
```

`npm run --silent mcp:server` and `npm run --silent mcp:cli -- <args>` build and run without installing. Use `--silent`: npm's own banner would otherwise be written to the MCP stdio stream.

## Credentials (manual renewal in this release)

The connector uses the **same native, short-lived Clerk JWT for the `convex` audience** that the web app sends to Convex. It does not accept an MCP OAuth access token as a Convex JWT, and it never uses a Convex deployment key.

1. Create a private file, for example `~/.config/lux/credentials/reotech.json`, mode `600`, owned by you:

   ```json
   { "version": 1, "instance": "https://<deployment>.convex.cloud", "token": "<clerk jwt for audience convex>" }
   ```

   ```sh
   mkdir -p ~/.config/lux/credentials
   install -m 600 /dev/null ~/.config/lux/credentials/reotech.json
   ```

2. Point `LUX_CREDENTIAL_FILE` at it. The token is **not** a command-line argument, tracked file or log entry.
3. Obtain a fresh token while signed in to the Lux web app and rewrite the file when it expires. For this developer bootstrap, use the browser's Network panel to inspect the Clerk request for the `convex` JWT template after refreshing the app. Keep the returned JWT private and store it only in the credential file. The app calls `clerk.session.getToken({ template: 'convex' })` internally; its Clerk instance is module-local, so this is not a global browser-console command. Renewal is manual: there is no `lux auth login` yet. Tokens are short-lived; expect to repeat this. A later release should use the operating system's credential store instead of a plaintext file. Until then protection relies on owner-only mode, no symlinks, a size limit, and ownership by the current user.

The JWT retains the user's normal backend permissions. Read-only describes the connector's available tools, not a separately restricted credential grant.

The file is read on **every call**, so a rotated token takes effect without restarting the server. Before sending anything, the connector rejects an expired token or one that is not for the `convex` audience (a convenience check only: Convex verifies the signature and decides access on every call). The credential file's `instance` is the destination you trust. Windows is not supported for credential files in this release.

## Link a repository

```sh
lux link --instance https://<deployment>.convex.cloud --workspace <workspaceId> --project <projectId>
```

`link` calls the backend first and writes `.lux.json` only if you can access that project:

```json
{ "version": 1, "instance": "https://<deployment>.convex.cloud", "workspace": "<workspaceId>", "project": "<projectId>" }
```

It holds no secret and grants no access; commit it. IDs are immutable Lux IDs. List yours with `lux context` and `lux context --workspace <id>`. `link` refuses to replace an existing file without `--force`.

- The closest `.lux.json` between the working directory and the Git root wins. Linked Git worktrees are their own root. An invalid closest file is an error; Lux never falls back to another workspace or to an account-wide "current" workspace.
- The binding's `instance` must equal the credential file's `instance`, or no request is sent. A repository therefore cannot redirect your token to another server. Only `https` origins are accepted (no credentials, path, query or fragment).
- For local tests only, `LUX_ALLOW_INSECURE_LOOPBACK=1` additionally allows `http://127.0.0.1:<port>` (or `[::1]`). Never set it in production.

## CLI

```sh
lux context                       # pinned selection, or your workspaces when unbound
lux search --query "login" --status todo --limit 20 [--cursor <c>] [--assignee <memberId> | --unassigned]
lux get LUX-42 [--description]    # or: lux get --id <taskId>
```

All accept `--project-dir <dir>` and explicit `--workspace`/`--project`. Defaults come from the binding; a project is inherited only together with the binding's own workspace. The backend authorizes every call, so an explicit ID you cannot access is rejected. Limits: `limit` 1-50 (default 20); descriptions are omitted unless requested.

## MCP clients

`lux mcp` serves MCP over stdio. It needs a verified project directory: `--project-dir <dir>` or `CLAUDE_PROJECT_DIR`. It does not use the shell's working directory. The binding is read once at startup and fixed for the process; two clients keep independent contexts. Tools: `lux_context`, `lux_search`, `lux_get` (all read-only; results are structured plus a compact JSON text copy; a result over 32 KiB is refused rather than truncated).

### Claude Code

```sh
claude mcp add --transport stdio --env LUX_CREDENTIAL_FILE=$HOME/.config/lux/credentials/reotech.json lux -- lux mcp
```

Claude Code sets `CLAUDE_PROJECT_DIR` for stdio servers. Or install the thin plugin in [`plugins/lux`](../plugins/lux): it registers the same server (`lux mcp --project-dir ${CLAUDE_PROJECT_DIR}`) and one short workflow skill. Do not add both the plugin and a manual `lux` server.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.lux]
command = "lux"
args = ["mcp", "--project-dir", "/absolute/path/to/repository"]
env = { LUX_CREDENTIAL_FILE = "/Users/you/.config/lux/credentials/reotech.json" }
```

Use one entry per repository, since Codex does not supply a verified project directory.

## Errors

Every error is `CODE: message` plus one next step, and never includes the token. Notable codes: `AUTH_REQUIRED`, `AUTH_EXPIRED`, `AUTH_INVALID`, `AUTH_FILE_UNSAFE`, `BINDING_INVALID`, `INSTANCE_MISMATCH`, `CONTEXT_REQUIRED`, `INVALID_INPUT`, `OUTPUT_TOO_LARGE`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_TIMEOUT`, `REQUEST_CANCELLED`, and backend codes such as `AGENT_CURSOR_INVALID` or `AGENT_INDEX_NOT_READY` (an operator must complete the index backfill). Backend calls time out after 15 seconds, including response-body reads. MCP cancellation aborts the pending backend request.

## Not in this release

Hosted `/mcp`, OAuth, browser login, credential-store integration, task/comment writes, and Windows credential files. Hosted access stays blocked until the actual Clerk issuer, resource and audience mapping is proved to resolve to the same Lux member as the browser, including wrong-audience, expired, revoked-member, private-project and simultaneous-workspace cases. An MCP OAuth token must not be accepted as a Convex JWT, and no deployment key may be used as a user credential.

## Reusing the kit

`@reotech/mcp-kit` is application-neutral; see [its README](../packages/mcp-kit/README.md). Its Streamable HTTP handler requires the host to supply a verifier. Tests drive it with a fixture verifier through the SDK client; that is not production authentication.
