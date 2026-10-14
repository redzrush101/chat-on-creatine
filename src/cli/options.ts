import { resolve } from 'node:path';
import { REASONING_EFFORTS, type ReasoningEffort } from '@shared/config';
import type { ReviewTarget } from '@shared/types';

export interface CliOptions {
  command: 'chat' | 'exec' | 'review' | 'mcp' | 'login' | 'status' | 'models' | 'sessions' | 'stop';
  cwd: string;
  profile?: string;
  prompt: string;
  print: boolean;
  json: boolean;
  trust: boolean;
  yolo: boolean;
  resume: string | null;
  allSessions: boolean;
  review: ReviewTarget;
  output?: string;
  additionalRoots: string[];
  mcpArgs: string[];
  name?: string;
  model?: string;
  effort?: ReasoningEffort;
  mode: 'off' | 'goal' | 'loop';
  attachments: string[];
  timeoutMs: number;
  help: boolean;
  version: boolean;
}

export function parseOptions(args: string[], cwd = process.cwd()): CliOptions {
  const result: CliOptions = { command: 'chat', cwd, prompt: '', print: false, json: false, trust: false, yolo: false,
    resume: null, allSessions: false, review: { kind: 'uncommitted' }, additionalRoots: [], mcpArgs: [],
    mode: 'off', attachments: [], timeoutMs: 600_000, help: false, version: false };
  const words: string[] = [];
  const value = (index: number): string => {
    const text = args[index + 1];
    if (!text || text.startsWith('-')) throw new Error(`${args[index]} needs a value.`);
    return text;
  };
  let literal = false;
  let resumeCommand = false;
  let reviewScope = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (literal) { words.push(arg); continue; }
    if (arg === '--') { literal = true; continue; }
    if (!words.length && !resumeCommand && result.command === 'chat' && ['exec', 'review', 'mcp', 'login', 'status', 'models', 'sessions'].includes(arg)) {
      result.command = arg as CliOptions['command']; result.print = arg === 'exec' || arg === 'review';
      if (arg === 'mcp') { result.mcpArgs = args.slice(i + 1); break; }
      continue;
    }
    if (!words.length && !resumeCommand && ['chat', 'exec'].includes(result.command) && arg === 'resume') {
      resumeCommand = true; result.resume = 'picker'; continue;
    }
    if (!words.length && result.command === 'exec' && arg === 'review') {
      result.command = 'review'; continue;
    }
    if (!words.length && result.command === 'chat' && arg === 'daemon') {
      if (args[++i] !== 'stop') throw new Error('Usage: creatine daemon stop');
      result.command = 'stop'; continue;
    }
    switch (arg) {
      case '-h': case '--help': result.help = true; break;
      case '-v': case '--version': result.version = true; break;
      case '-p': case '--print': result.print = true; break;
      case '--json': result.json = true; result.print = true; break;
      case '--trust': result.trust = true; break;
      case '--yolo': result.yolo = true; break;
      case '-c': case '--continue': case '--last': result.resume = 'latest'; break;
      case '--all': result.allSessions = true; break;
      case '-r': case '--resume':
        result.resume = args[i + 1] && !args[i + 1]!.startsWith('-') ? value(i++) : 'picker'; break;
      case '-n': case '--name': result.name = value(i++).trim().slice(0, 120); if (!result.name) throw new Error('--name needs a nonempty title.'); break;
      case '-C': case '--cwd': result.cwd = resolve(cwd, value(i++)); break;
      case '--user-data': result.profile = resolve(cwd, value(i++)); break;
      case '--add-dir': result.additionalRoots.push(resolve(cwd, value(i++))); break;
      case '-o': case '--output-last-message': result.output = resolve(cwd, value(i++)); result.print = true; break;
      case '--uncommitted': case '--base': case '--commit':
        if (reviewScope) throw new Error('Choose only one review scope: --uncommitted, --base or --commit.');
        reviewScope = true;
        result.review = arg === '--uncommitted' ? { kind: 'uncommitted' } : { kind: arg === '--base' ? 'base' : 'commit', revision: value(i++) };
        break;
      case '-m': case '--model': result.model = value(i++); break;
      case '--effort': {
        const effort = value(i++);
        if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) throw new Error(`Unknown effort ${effort}. Choose ${REASONING_EFFORTS.join(', ')}.`);
        result.effort = effort as ReasoningEffort; break;
      }
      case '--goal': result.mode = 'goal'; break;
      case '--loop': result.mode = 'loop'; break;
      case '-i': case '--image': case '--attach': result.attachments.push(resolve(cwd, value(i++))); break;
      case '--timeout': {
        const seconds = Number(value(i++));
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be a positive number of seconds.');
        result.timeoutMs = seconds * 1000; break;
      }
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option ${arg}. See creatine --help.`);
        words.push(arg);
    }
  }
  if (resumeCommand && result.resume === 'picker' && words.length) result.resume = words.shift()!;
  if (reviewScope && result.command !== 'review') throw new Error('Review scope flags require creatine review or creatine exec review.');
  if (result.command === 'review' && result.mode !== 'off') throw new Error('Code review runs once. Omit --goal and --loop.');
  if (result.allSessions && !result.resume) throw new Error('--all requires a resumed session.');
  if (result.mode === 'loop' && result.print) throw new Error('Loop runs until stopped. Use it in interactive mode.');
  if (result.resume === 'picker' && result.print) throw new Error('Noninteractive --resume needs a session ID. Use --continue for the latest chat.');
  result.prompt = words.join(' ');
  return result;
}

export const CLI_HELP = `Chat on Creatine — ChatGPT in your terminal

Usage: creatine [options] [prompt]
       creatine exec [options] [prompt]       Run a task and exit
       creatine review [options] [focus]      Review changes and exit
       creatine resume [id | --last] [prompt] Resume a chat (picker by default)
       creatine exec resume <id | --last> [prompt]
       creatine mcp <command>                Manage shared MCP plugin servers
       creatine login                       Open the shared ChatGPT sign-in page
       creatine status | models | sessions
       creatine daemon stop                 Quit the shared Electron backend

Options:
  -C, --cwd <folder>       Work in this folder (defaults to the current directory)
  -r, --resume [id]        Resume a shared session, or open a searchable picker
  -c, --continue           Resume the latest chat in this folder
      --last               Alias for --continue; resume --all searches every folder
      --all                Resume across folders, including with --last
  -n, --name <title>       Name the new or resumed chat
  -m, --model <id>         Pick a model from your ChatGPT account
      --effort <level>     Pick a supported reasoning level
      --goal               Keep working until the objective is met
      --loop               Repeat the brief until stopped (interactive)
  -i, --image, --attach <file> Attach a file (repeatable, maximum 50 MB each)
      --add-dir <folder>   Approve another tool folder (repeatable, shared with GUI)
      --trust              Approve the working folder for local tools
      --yolo               Enable shared unrestricted mode (all paths and tools)
  -p, --print              Run once; print the final answer to stdout
      --json               Emit session, event and result records as JSON lines
  -o, --output-last-message <file> Save the successful final answer; implies --print
      --uncommitted        Review staged, unstaged and untracked changes (default)
      --base <revision>    Review committed changes since the merge base with HEAD
      --commit <revision>  Review one commit, including an initial commit
      --timeout <seconds>  Limit a noninteractive task (default: 600)
      --user-data <path>   Use an isolated profile instead of the GUI's profile
  -h, --help               Show this help
  -v, --version            Show the version

Use - as the prompt to read stdin. Piped stdin is included in the prompt.
MCP commands: list [--json], get <name> [--json], add <name> -- <command> [args],
add <name> --url <http(s) URL>, remove|enable|disable|restart <name>.
Put global options such as --user-data before mcp. Interactive controls: Enter sends;
Ctrl+J or Alt+Enter adds a line; Tab completes; Esc stops; Ctrl+C stops or exits.
@file includes text; @file:10-30 selects lines; @"file with spaces" quotes a path.
Ctrl+G opens VISUAL/EDITOR; Ctrl+V or Alt+V pastes images; Ctrl+L clears the screen.
Ctrl+P cycles models; Shift+Tab cycles reasoning. /context reload loads prompt templates.
Use /help for sessions, models, plans, agents, skills, permissions and setup.
The CLI shares login, history, approved folders and settings with the GUI.
`;
