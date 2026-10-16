export const COMMANDS: Record<string, string> = {
  help: 'Show commands and keyboard controls', exit: 'Leave the CLI',
  new: 'Start a new chat', resume: 'Resume by ID or title; --list lists chats, --search searches messages',
  review: 'Review changes; /review [--base <ref> | --commit <ref>] [focus]', init: 'Inspect the project and create AGENTS.md; preserve an existing file',
  copy: 'Copy the latest completed final answer to the clipboard',
  settings: 'Search shared settings; /settings <key> <value> or /settings reset <key>',
  usage: 'Show context breakdown, turns and tool usage for this chat',
  name: 'Name this chat',
  model: 'Choose model and reasoning; /model <id> [effort]', status: 'Account and tools; /status connect|disconnect|browser|logs',
  login: 'Open ChatGPT sign-in', gui: 'Open the desktop workspace and settings',
  attach: 'Attach a local file; /attach clear removes pending files', cd: 'Change working folder',
  context: 'Context breakdown and pending shell output; /context clear|templates|reload',
  plan: 'Show the latest plan', tasks: 'Show commands, workers and queue; /tasks <worker-id> or /tasks stop <id>',
  queue: 'List queued inputs; /queue cancel|now|retry|edit <id>', stop: 'Stop the turn, queued messages and automation',
  goal: 'Run until an objective is met; /goal off stops automation', loop: 'Repeat a brief until stopped', compact: 'Compact and resume this chat',
  diff: 'Show project changes or /diff <file>',
  skills: 'List skills; /skills import <folder> or /skills remove <id>',
  mcp: 'List MCP tools; /mcp add|get|remove|enable|disable|restart manages servers',
  permissions: 'Choose shared permissions; /permissions approve [folder]', setup: 'Configure the shared MCP tunnel'
};

export const COMMAND_PATTERN = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i;
