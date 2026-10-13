export const COMMANDS: Record<string, string> = {
  help: 'Show commands and keyboard controls', exit: 'Leave the CLI', quit: 'Leave the CLI',
  new: 'Start a new chat', resume: 'Resume by ID or search title; current folder first',
  review: 'Review changes; /review [--base <ref> | --commit <ref>] [focus]', init: 'Inspect the project and create AGENTS.md; preserve an existing file',
  copy: 'Copy the latest completed final answer to the clipboard',
  sessions: 'List shared chats; /sessions <query> filters titles and IDs', name: 'Name this chat', search: 'Search messages and resume a matching chat',
  model: 'Choose a model and reasoning level', effort: 'Change reasoning level', status: 'Account, tools and session status',
  login: 'Open ChatGPT sign-in', browser: 'Show this chat in ChatGPT', gui: 'Open the desktop workspace',
  attach: 'Attach a local file; /attach clear removes pending files', paste: 'Paste clipboard image or text', cd: 'Change working folder',
  editor: 'Edit the draft in VISUAL or EDITOR (Ctrl+G)', templates: 'List reusable prompt commands', reload: 'Reload prompt templates', context: 'Show pending shell context; /context clear discards it',
  plan: 'Show the latest plan', agents: 'Inspect workers; /agents stop <id> stops one', tasks: 'Show workers and queued messages',
  queue: 'List queued inputs; /queue cancel|now|retry|edit <id>', steer: 'Send a message into the running turn', stop: 'Stop the turn and automation',
  goal: 'Run until an objective is met; /goal off stops automation', loop: 'Repeat a brief until stopped', compact: 'Compact and resume this chat',
  diff: 'Show project changes or /diff <file>', export: 'Export this chat as Markdown to a file',
  skills: 'List skills; /skills import <folder> or /skills remove <id>', plugins: 'List plugin servers; /plugins restart <id>',
  mcp: 'List MCP tools; /mcp add|get|remove|enable|disable|restart manages servers',
  permissions: 'Choose shared tool permissions', approve: 'Approve a folder for local tools', setup: 'Configure the shared MCP tunnel',
  connect: 'Connect local tools', disconnect: 'Disconnect local tools', logs: 'Show recent backend logs',
  clear: 'Clear the terminal view'
};

export const COMMAND_PATTERN = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i;
