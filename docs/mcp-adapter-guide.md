# Build another application's MCP

Use the portable [reotech-mcp-build skill](../skills/reotech-mcp-build/SKILL.md) and its [adapter guide](../skills/reotech-mcp-build/references/adapter-guide.md) to implement the next application with the same `@reotech/mcp-kit` as Lux. The guide includes package acquisition, a typed factory, permission/context boundaries, real review lessons and verification cases.

The kit is reusable today. The shared ContextForge gateway and hosted Lux OAuth are not deployed by this foundation. Each app owns its adapter and native permissions; a future gateway can route selected catalogs.

## Give an agent the task

For a host that discovers installed skills:

```text
Use $reotech-mcp-build to implement a read-only MCP for <application>.
Reuse @reotech/mcp-kit from the Lux source checkout at <absolute path>.
Start with <operations>. Pin repository defaults where the app has that scope.
Use the application's current authentication and authorization.
Validate the real MCP transport and host startup, document any fixture limits,
and follow this project's PR workflow. Deployment is a separate task.
```

Claude can invoke the installed skill as `/reotech-mcp-build`. For Cursor or another client without skill discovery, give the same task and ask it to read `skills/reotech-mcp-build/SKILL.md` plus the linked guide. Skill files are ordinary Markdown and do not depend on Codex tools.

## Install or share the skill

Copy the entire `skills/reotech-mcp-build` directory to the host's skill directory. Keep `references/` beside `SKILL.md`; it makes the installed skill self-contained. Copying the skill does not install the kit, configure an MCP connection or grant deployment access.

For example, run from this Lux checkout. These commands refuse an existing destination so they do not overwrite another installation:

```sh
# Codex
mkdir -p "$HOME/.codex/skills"
test ! -e "$HOME/.codex/skills/reotech-mcp-build" && \
  test ! -L "$HOME/.codex/skills/reotech-mcp-build" && \
  cp -R skills/reotech-mcp-build "$HOME/.codex/skills/"

# Claude Code
mkdir -p "$HOME/.claude/skills"
test ! -e "$HOME/.claude/skills/reotech-mcp-build" && \
  test ! -L "$HOME/.claude/skills/reotech-mcp-build" && \
  cp -R skills/reotech-mcp-build "$HOME/.claude/skills/"
```

Restart or refresh the host's skill discovery when needed. For repository-scoped sharing, commit the directory to the target project's supported skill location, or link it from that project's agent instructions. Choose the scope explicitly; this guide does not install into unrelated projects.

The guide links to the known working kit commit. When the kit changes, update the guide's provenance, check the examples against the new exports, and repeat affected behavior tests. Keep one canonical source rather than letting installed copies become separate transport implementations.
