import { resolve } from 'node:path';
import { REASONING_EFFORTS, type ReasoningEffort } from '@shared/config';

export interface CliOptions {
  command: 'chat' | 'exec' | 'login' | 'status' | 'models' | 'sessions' | 'stop';
  cwd: string;
  profile?: string;
  prompt: string;
  print: boolean;
  json: boolean;
  trust: boolean;
  yolo: boolean;
  resume: string | null;
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
    resume: null, mode: 'off', attachments: [], timeoutMs: 600_000, help: false, version: false };
  const words: string[] = [];
  const value = (index: number): string => {
    const text = args[index + 1];
    if (!text || text.startsWith('--')) throw new Error(`${args[index]} needs a value.`);
    return text;
  };
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (literal) { words.push(arg); continue; }
    if (arg === '--') { literal = true; continue; }
    if (!words.length && result.command === 'chat' && ['exec', 'login', 'status', 'models', 'sessions'].includes(arg)) {
      result.command = arg as CliOptions['command']; result.print = arg === 'exec'; continue;
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
      case '-c': case '--continue': result.resume = 'latest'; break;
      case '-r': case '--resume':
        result.resume = args[i + 1] && !args[i + 1]!.startsWith('-') ? value(i++) : 'picker'; break;
      case '-n': case '--name': result.name = value(i++).trim().slice(0, 120); if (!result.name) throw new Error('--name needs a nonempty title.'); break;
      case '-C': case '--cwd': result.cwd = resolve(cwd, value(i++)); break;
      case '--user-data': result.profile = resolve(cwd, value(i++)); break;
      case '-m': case '--model': result.model = value(i++); break;
      case '--effort': {
        const effort = value(i++);
        if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) throw new Error(`Unknown effort ${effort}. Choose ${REASONING_EFFORTS.join(', ')}.`);
        result.effort = effort as ReasoningEffort; break;
      }
      case '--goal': result.mode = 'goal'; break;
      case '--loop': result.mode = 'loop'; break;
      case '--attach': result.attachments.push(resolve(cwd, value(i++))); break;
      case '--timeout': {
        const seconds = Number(value(i++));
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be a positive number of seconds.');
        result.timeoutMs = seconds * 1000; break;
      }
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}. See creatine --help.`);
        words.push(arg);
    }
  }
  if (result.mode === 'loop' && result.print) throw new Error('Loop runs until stopped. Use it in interactive mode.');
  if (result.resume === 'picker' && result.print) throw new Error('Noninteractive --resume needs a session ID. Use --continue for the latest chat.');
  result.prompt = words.join(' ');
  return result;
}

export const CLI_HELP = `Chat on Creatine — ChatGPT in your terminal

Usage: creatine [options] [prompt]
       creatine exec [options] [prompt]       Run a task and exit
       creatine login                       Open the shared ChatGPT sign-in page
       creatine status | models | sessions
       creatine daemon stop                 Quit the shared Electron backend

Options:
  -C, --cwd <folder>       Work in this folder (defaults to the current directory)
  -r, --resume [id]        Resume a shared session, or open a searchable picker
  -c, --continue           Resume the latest chat in this folder
  -n, --name <title>       Name the new or resumed chat
  -m, --model <id>         Pick a model from your ChatGPT account
      --effort <level>     Pick a supported reasoning level
      --goal               Keep working until the objective is met
      --loop               Repeat the brief until stopped (interactive)
      --attach <file>      Attach a file (repeatable, maximum 50 MB each)
      --trust              Approve the working folder for local tools
      --yolo               Enable shared unrestricted mode (all paths and tools)
  -p, --print              Run once; print the final answer to stdout
      --json               Emit session, event and result records as JSON lines
      --timeout <seconds>  Limit a noninteractive task (default: 600)
      --user-data <path>   Use an isolated profile instead of the GUI's profile
  -h, --help               Show this help
  -v, --version            Show the version

Piped stdin is included in the prompt. Interactive controls: Enter sends;
Ctrl+J or Alt+Enter adds a line; Tab completes; Esc stops; Ctrl+C stops or exits.
@file includes text; @file:10-30 selects lines; @"file with spaces" quotes a path.
Ctrl+G opens VISUAL/EDITOR; Ctrl+V or Alt+V pastes images; /paste also works.
Ctrl+P cycles models; Shift+Tab cycles reasoning. /reload loads prompt templates.
Use /help for sessions, models, plans, agents, skills, permissions and setup.
The CLI shares login, history, approved folders and settings with the GUI.
`;
