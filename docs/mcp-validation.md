# MCP foundation validation

Validation on 2026-10-08 used Node 22 and isolated fixtures. No production deployment, Clerk login, data migration, or gateway connection was performed.

## Automated checks

- 131 tests passed across eight files. Existing backend tests also passed after the membership lookup changed to a compound index.
- Strict TypeScript, ESLint, Prettier, and the frontend production build passed. The build retains the existing Clerk/Zod bundler warnings.
- A clean temporary `npm ci` checkout built the kit and agent, launched the CLI, and started MCP without npm banners on protocol stdout.
- The shared package's dry-run archive was 10,962 bytes with JavaScript and declaration files. It was not published to npm.

The tests exercise native Convex function handlers through `convex-test`, SDK clients through in-memory/HTTP/stdio transports, and the actual `ConvexHttpClient` against a local stand-in. They cover current permissions and revocation, workspace isolation, bounded pages, legacy index backfill and checkpoint recovery, safe credential destinations, rotation, timeout/cancellation, malformed HTTP authorization, and FIFO rejection.

## Actual host interactions

| Host                                  | Observed behavior                                                                                                                     | Limit                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI, final bundle               | Context, search, and get succeeded with no workspace/project arguments. Backend requests received the repository's pinned IDs.        | An incorrect test prompt initially supplied a top-level key; a corrected retry used the declared `task: { key }` input.                                                                                                             |
| Claude Code, manual MCP configuration | All three reads succeeded using repository defaults. Exactly three Lux tools were discovered.                                         | This was the initial bundle, before timeout/cancellation hardening. It is historical compatibility evidence; final stdio regression tests also pass.                                                                                |
| Claude Code, final plugin             | Exactly one Lux server connected, three read tools were exposed, the workflow skill loaded, and context resolved through the binding. | The full requested three-call sequence did not complete. Claude added account-level connectors despite temporary local configuration; the model supplied explicit search scope and skipped get. No other connector tool was called. |

Host authentication was an unsigned JWT-shaped fixture accepted by a fake local backend. Successful host calls demonstrate transport compatibility, schema handling, and repository defaults, not production identity. Host model resolution and account-level catalog behavior are recorded as limits in the private artifacts.

The catalog test enforces fewer than 8,000 serialized characters for the three Lux tools. Results have a 32 KiB structured-data budget plus a compact text compatibility copy. These are measured size bounds, not a claim that every host injects the same number of tokens. Whole-workflow token cost still needs a production-compatible benchmark.

## Independent review

Claude Opus reviewed the credential, binding, and HTTP boundaries independently. FIFO hangs, missing upstream deadlines/cancellation, and exceptional authorization handling were fixed and re-reviewed. The second review found no material remaining issue in its scoped source review. A subsequent compatibility adjustment aligned engines and launcher checks with Node 22.

## Evidence and remaining gates

The no-media evidence plan covers the kit, native reads, index maintenance, CLI/plugin, and second adapter. No rendered UI changed; protocol and authorization assertions provide the relevant evidence.

Sanitized host records, review rounds, the Ops report, and the revision ledger are retained privately outside Git. The PR includes this summary and reproducible tests rather than claiming those local artifacts are attached to GitHub.

Hosted Clerk identity/resource/audience equivalence, ContextForge direct-versus-proxied calls, production backfill, and actual provider synchronization remain unverified. See [setup](mcp-setup.md), [index maintenance](mcp-index-migration.md), and [hosting findings](mcp-hosting.md).
