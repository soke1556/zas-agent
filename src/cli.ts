// The executable. Three things it can do: print its version, pair this machine
// with a Zas account, or serve the MCP tools over stdio — which is what a
// coding agent starts it for, and what the two install snippets configure.
//
// Stdout belongs to the MCP transport. Every line this file writes for a person
// to read goes to stderr, because one stray `console.log` while serving is a
// protocol error in the client rather than a message anyone sees. The one
// exception is `--version`: it connects no transport, so its whole output is
// the answer, and a caller piping it deserves it on stdout.
import { realpathSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAgentKind, type AgentKind } from './shared/agent.js';
import { humanSentence, ZasError } from './errors.js';
import { defaultEndpoints, PROFILE_RE } from './identity.js';
import { openInBrowser } from './open.js';
import { runPair } from './pair.js';
import { agentVersion, buildServer } from './server.js';
import { kindForProfile } from './snippets.js';

/** What a bare `zas-agent` and a bare `zas-agent pair` mean. The install
 *  snippets always pass `--profile`, so this only decides for someone typing
 *  the command by hand, and `kindForProfile` turns it into the kind the owner
 *  will see in the approval list. */
const DEFAULT_PROFILE = 'claude-code';

interface Parsed {
  command: 'serve' | 'pair' | 'version' | 'help' | 'invalid';
  profile: string;
  kind?: AgentKind;
  host?: string;
  unknown?: string;
  /** The line `invalid` prints before exiting 2. */
  message?: string;
  /** `--no-open`, or the ZAS_NO_OPEN env var: do not launch a browser. */
  noOpen?: boolean;
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { command: 'serve', profile: DEFAULT_PROFILE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `--flag=value` and `--flag value` both, because both are typed.
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined;
    const take = (): string => (inline !== undefined ? inline : (argv[++i] ?? ''));
    if (name === 'pair') parsed.command = 'pair';
    else if (name === '--version' || name === '-v') parsed.command = 'version';
    else if (name === '--help' || name === '-h') parsed.command = 'help';
    else if (name === '--profile') {
      parsed.profile = take() || DEFAULT_PROFILE;
      if (!PROFILE_RE.test(parsed.profile)) {
        return { ...parsed, command: 'invalid', message: `Invalid profile: ${parsed.profile}` };
      }
    } else if (name === '--kind') {
      const kind = take();
      // An unreadable kind is a typo, and guessing `other` would pair an agent
      // the owner cannot recognise in the list. It stops instead.
      if (!isAgentKind(kind)) return { ...parsed, command: 'help', unknown: `--kind ${kind}` };
      parsed.kind = kind;
    } else if (name === '--no-open') parsed.noOpen = true;
    // A flag with nothing after it is not a blank host: `runPair` fills in
    // `hostname()` for `undefined`, and that name is how the owner recognises
    // the machine in the approval list.
    else if (name === '--host') parsed.host = take() || undefined;
    else return { ...parsed, command: 'help', unknown: arg };
  }
  return parsed;
}

const USAGE = [
  'zas-agent — send files and notes from a coding agent into your Zas channels.',
  '',
  '  zas-agent [--profile <name>]                serve the MCP tools over stdio',
  '  zas-agent pair [--profile <name>]           pair this machine with a Zas account',
  '                 [--kind claude_code|codex|other] [--host <name>] [--no-open]',
  '  zas-agent --version',
].join('\n');

export async function main(argv: string[], log: (line: string) => void = (l) => console.error(l)): Promise<number> {
  const args = parseArgs(argv);

  if (args.command === 'version') {
    console.log(agentVersion());
    return 0;
  }

  if (args.command === 'invalid') {
    log(args.message ?? '');
    return 2;
  }

  if (args.command === 'help') {
    if (args.unknown) log(`Unknown argument “${args.unknown}”.`);
    log(USAGE);
    return args.unknown ? 2 : 0;
  }

  if (args.command === 'pair') {
    // A prompt only where somebody can answer it: an MCP client, a script or a
    // pipe has no person on stdin, and a question there would hang forever.
    let rl: Interface | null = null;
    const askCode = process.stdin.isTTY
      ? () => {
          rl ??= createInterface({ input: process.stdin, output: process.stderr });
          return new Promise<string>((resolve) => { rl!.question('Type the code shown in the browser: ', resolve); });
        }
      : undefined;
    const noOpen = args.noOpen === true || process.env.ZAS_NO_OPEN === '1';
    try {
      await runPair({
        profile: args.profile,
        kind: args.kind ?? kindForProfile(args.profile),
        ...(args.host !== undefined ? { host: args.host } : {}),
        webBase: process.env.ZAS_WEB_BASE || 'https://zas.red',
        apiBase: defaultEndpoints().api_base,
        log,
        ...(askCode ? { askCode } : {}),
        ...(noOpen ? {} : { open: openInBrowser }),
      });
    } catch (e) {
      const err = e instanceof ZasError ? e : new ZasError('internal', 0, String(e));
      log(humanSentence(err));
      return 1;
    } finally {
      // A question still open would hold stdin, and the process, forever.
      // The cast works around TypeScript narrowing `rl` to `null` here: the
      // only assignment it sees in this scope is the initializer, since the
      // other one lives inside `askCode`'s closure.
      (rl as Interface | null)?.close();
    }
    // `runPair`'s own last line already carries the install snippet for the
    // profile it paired and the kind it paired as; printing them again here
    // only doubled it.
    return 0;
  }

  await buildServer(args.profile).connect(new StdioServerTransport());
  // The transport owns the process from here: it holds stdin open, and the
  // client closing it is what ends the run.
  return 0;
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return '';
  }
};

/** Whether this process was started as the executable, rather than imported by
 *  a test. Both sides are resolved through the filesystem because npm installs
 *  the bin as a symlink — `node_modules/.bin/zas-agent -> ../zas-agent/dist/cli.js`
 *  — and Node puts the *link* in `argv[1]` while `import.meta.url` names the
 *  real file. Comparing the two as strings made the installed command a no-op
 *  on macOS and Linux. */
export function isInvokedDirectly(argv1: string | undefined, selfUrl: string): boolean {
  if (argv1 === undefined || argv1 === '') return false;
  const entry = real(argv1);
  if (entry === '') return false;
  let self = '';
  try {
    self = real(fileURLToPath(selfUrl));
  } catch {
    return false;
  }
  return self !== '' && self === entry;
}

if (isInvokedDirectly(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { if (code !== 0) process.exitCode = code; },
    (error: unknown) => {
      console.error(String((error as Error)?.stack ?? error));
      process.exitCode = 1;
    },
  );
}
