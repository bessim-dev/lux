import { parseArgs } from 'node:util';
import { BindingError, ToolError, findGitRoot, resolveProjectDir, serveMcpOverStdio, toSafeError, writeBinding } from '@reotech/mcp-kit';
import { BINDING_FILE, bindingSpec, findLuxBinding } from './binding';
import { convexBackend, type BackendFactory } from './backend';
import { readEnvironment, type LuxEnvironment } from './config';
import { createAgentService, type AgentService } from './service';
import { LUX_INSTRUCTIONS, LUX_SERVER_NAME, LUX_SERVER_VERSION, createLuxTools } from './tools';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliDeps {
  backend?: BackendFactory;
  cwd?: string;
  now?: () => number;
}

/** Exit code, or 'serving' once the stdio server owns the process lifetime. */
export type CliResult = number | 'serving';

export const USAGE = `lux <command> [options]

  link --instance <url> --workspace <id> --project <id> [--force]   verify access, then write .lux.json
  mcp                                                              serve MCP over stdio (needs --project-dir or CLAUDE_PROJECT_DIR)
  context [--workspace <id>] [--project <id>] [--limit n] [--cursor c]
  search  [--workspace <id>] [--project <id>] [--query q] [--status s] [--assignee <id> | --unassigned] [--limit n] [--cursor c]
  get     <KEY> | --id <id>  [--workspace <id>] [--project <id>] [--description]

Every command accepts --project-dir <dir>. Credentials: LUX_CREDENTIAL_FILE (see docs/mcp-setup.md).
`;

const usage = (message: string) => new ToolError('USAGE', message, { hint: 'Run `lux --help`.' });

/** parseArgs failures are usage errors, not crashes. */
function strictly<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw usage(error instanceof Error ? error.message : 'Invalid arguments.');
  }
}

function limitOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw usage('--limit must be a whole number.');
  return Number(raw);
}

export async function runCli(argv: readonly string[], io: CliIo, env: Readonly<Record<string, string | undefined>>, deps: CliDeps = {}): Promise<CliResult> {
  const logInternal = (reference: string, description: string) => io.stderr(`lux: internal error ${reference}: ${description}\n`);
  try {
    return await dispatch(argv, io, readEnvironment(env), deps, logInternal);
  } catch (error) {
    const safe = toSafeError(error instanceof BindingError ? new ToolError(error.problem, error.message) : error, { onInternalError: logInternal });
    io.stderr(`${safe.code}: ${safe.message}${safe.hint ? `\nNext: ${safe.hint}` : ''}\n`);
    return safe.code === 'USAGE' ? 2 : 1;
  }
}

async function dispatch(
  argv: readonly string[],
  io: CliIo,
  environment: LuxEnvironment,
  deps: CliDeps,
  logInternal: (reference: string, description: string) => void,
): Promise<CliResult> {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  const projectDir = (explicit: string | undefined, interactive: boolean) =>
    resolveProjectDir({ explicit, fromEnvironment: environment.claudeProjectDir, ...(interactive ? { fallback: deps.cwd ?? process.cwd() } : {}) });
  const serviceOptions = (binding: AgentService['binding']) => ({
    binding,
    credentialFile: environment.credentialFile,
    allowLoopbackHttp: environment.allowLoopbackHttp,
    backend: deps.backend ?? convexBackend,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const pinnedService = async (dir: string): Promise<AgentService> =>
    createAgentService(serviceOptions((await findLuxBinding(dir, environment.allowLoopbackHttp))?.binding ?? null));
  const print = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);

  switch (command) {
    case 'mcp': {
      const { values } = strictly(() => parseArgs({ args, options: { 'project-dir': { type: 'string' } }, strict: true }));
      const service = await pinnedService(await projectDir(values['project-dir'], false));
      serveMcpOverStdio(
        {
          name: LUX_SERVER_NAME,
          version: LUX_SERVER_VERSION,
          instructions: LUX_INSTRUCTIONS,
          tools: createLuxTools(),
          resolveContext: () => service,
          onInternalError: logInternal,
        },
        { onerror: error => io.stderr(`lux: transport error: ${error.message}\n`) },
      );
      return 'serving';
    }
    case 'link': {
      const { values } = strictly(() =>
        parseArgs({
          args,
          options: {
            'project-dir': { type: 'string' },
            instance: { type: 'string' },
            workspace: { type: 'string' },
            project: { type: 'string' },
            force: { type: 'boolean' },
          },
          strict: true,
        }),
      );
      if (!values.instance || !values.workspace || !values.project) throw usage('link needs --instance, --workspace and --project.');
      const spec = bindingSpec(environment.allowLoopbackHttp);
      const requested = spec.schema.safeParse({ version: 1, instance: values.instance, workspace: values.workspace, project: values.project });
      if (!requested.success)
        throw usage(`Invalid link arguments: ${requested.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
      const root = await findGitRoot(await projectDir(values['project-dir'], true));
      // A service pinned to the requested destination: the credential's instance must match it before any request is sent.
      const verified = await createAgentService(serviceOptions(requested.data)).context({});
      if (verified.kind !== 'selection') throw new ToolError('BACKEND_RESPONSE_INVALID', 'Unexpected response while verifying the link.');
      await writeBinding(`${root}/${BINDING_FILE}`, requested.data, spec, { overwrite: values.force === true });
      io.stdout(
        `Linked ${verified.selection.workspace.name} / ${verified.selection.project.key} (${verified.selection.project.name}): ${root}/${BINDING_FILE}\n`,
      );
      return 0;
    }
    case 'context': {
      const { values } = strictly(() =>
        parseArgs({
          args,
          options: {
            'project-dir': { type: 'string' },
            workspace: { type: 'string' },
            project: { type: 'string' },
            limit: { type: 'string' },
            cursor: { type: 'string' },
          },
          strict: true,
        }),
      );
      const service = await pinnedService(await projectDir(values['project-dir'], true));
      print(await service.context({ workspace: values.workspace, project: values.project, limit: limitOf(values.limit), cursor: values.cursor }));
      return 0;
    }
    case 'search': {
      const { values } = strictly(() =>
        parseArgs({
          args,
          options: {
            'project-dir': { type: 'string' },
            workspace: { type: 'string' },
            project: { type: 'string' },
            query: { type: 'string' },
            status: { type: 'string' },
            assignee: { type: 'string' },
            unassigned: { type: 'boolean' },
            limit: { type: 'string' },
            cursor: { type: 'string' },
          },
          strict: true,
        }),
      );
      if (values.assignee !== undefined && values.unassigned) throw usage('Use either --assignee or --unassigned.');
      const service = await pinnedService(await projectDir(values['project-dir'], true));
      print(
        await service.search({
          workspace: values.workspace,
          project: values.project,
          query: values.query,
          status: values.status,
          assignee: values.unassigned ? null : values.assignee,
          limit: limitOf(values.limit),
          cursor: values.cursor,
        }),
      );
      return 0;
    }
    case 'get': {
      const { values, positionals } = strictly(() =>
        parseArgs({
          args,
          options: {
            'project-dir': { type: 'string' },
            workspace: { type: 'string' },
            project: { type: 'string' },
            id: { type: 'string' },
            description: { type: 'boolean' },
          },
          allowPositionals: true,
          strict: true,
        }),
      );
      if ((values.id === undefined) === (positionals.length === 0) || positionals.length > 1)
        throw usage('get needs exactly one task: a KEY argument or --id <id>.');
      const key = positionals[0];
      const service = await pinnedService(await projectDir(values['project-dir'], true));
      print(
        await service.get({
          workspace: values.workspace,
          project: values.project,
          task: values.id !== undefined ? { id: values.id } : key === undefined ? undefined : { key },
          includeDescription: values.description === true,
        }),
      );
      return 0;
    }
    default:
      throw usage(`Unknown command: ${command}`);
  }
}
