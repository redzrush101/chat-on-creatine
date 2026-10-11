import { z } from 'zod';

/** Reasoning levels offered by ChatGPT's picker. `null` everywhere means "account default". */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'pro'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const CAPABILITIES = ['read', 'write', 'create', 'delete', 'move', 'exec', 'search', 'browser'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Capabilities = Record<Capability, boolean>;

const capabilitiesSchema = z.object(
  Object.fromEntries(CAPABILITIES.map((name) => [name, z.boolean().default(name !== 'browser')])) as Record<
    Capability,
    z.ZodDefault<z.ZodBoolean>
  >
);

const rootSchema = z.object({
  id: z.string(),
  path: z.string(),
  label: z.string().default('')
});
export type Root = z.infer<typeof rootSchema>;

const pluginServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'http']),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  /** Non-secret environment. Secret values live in the SecretStore under `plugin:<id>:env:<NAME>`. */
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().default(''),
  /** Tool names the user switched off for this server. */
  disabledTools: z.array(z.string()).default([])
});
export type PluginServerConfig = z.infer<typeof pluginServerSchema>;

export const DEFAULT_HANDOFF_PROMPT =
  'We are moving this work to a fresh chat because the context is getting long. Write a dense handoff brief ' +
  '(roughly 2,000-6,000 tokens for substantial work) that lets a new assistant continue without this conversation: ' +
  'the user\'s goal and constraints in their own words, the current state of the work, decisions made and why, files ' +
  'touched, commands and checks that matter, open problems, and the exact next steps. Prefer facts over chronology. ' +
  'Reply with the brief only.';

export const configSchema = z.object({
  version: z.literal(1).default(1),
  roots: z.array(rootSchema).default([]),
  capabilities: capabilitiesSchema.default(() => capabilitiesSchema.parse({})),
  readOnly: z.boolean().default(false),
  commandPolicy: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['allowlist', 'denylist']).default('allowlist'),
      /** Exact argv prefixes, e.g. `git status` or `npm run *` (a standalone trailing `*` allows extra args). */
      rules: z.array(z.string()).default([])
    })
    .default(() => ({ enabled: false, mode: 'allowlist' as const, rules: [] })),
  connection: z
    .object({
      kind: z.enum(['openai', 'cloudflared', 'manual']).default('openai'),
      tunnelId: z.string().default(''),
      desktopTunnelId: z.string().default(''),
      pluginsTunnelId: z.string().default(''),
      tunnelClientPath: z.string().default(''),
      cloudflaredPath: z.string().default(''),
      /** Fixed loopback port for the MCP listener; 0 picks a free one. */
      port: z.number().int().min(0).max(65535).default(0),
      autoConnect: z.boolean().default(true),
      /** Appended to connector names ("Chat on Creatine Core (Laptop)") for one account on several machines. */
      connectorSuffix: z.string().default('')
    })
    .default(() => ({
      kind: 'openai' as const,
      tunnelId: '',
      desktopTunnelId: '',
      pluginsTunnelId: '',
      tunnelClientPath: '',
      cloudflaredPath: '',
      port: 0,
      autoConnect: true,
      connectorSuffix: ''
    })),
  browser: z
    .object({
      /** Where ChatGPT runs: the app's own browser, or the user's Chrome through the companion extension. */
      host: z.enum(['builtin', 'extension']).default('builtin'),
      /** Loopback port the companion extension connects to. */
      bridgePort: z.number().int().min(1024).max(65535).default(8765),
      /** Idle app-owned ChatGPT tabs close after this many minutes (history is kept). */
      idleTabMinutes: z.number().int().min(1).max(240).default(10),
      /** Allow tool calls whose ChatGPT conversation cannot be identified. */
      allowUnattributed: z.boolean().default(true)
    })
    .default(() => ({ host: 'builtin' as const, bridgePort: 8765, idleTabMinutes: 10, allowUnattributed: true })),
  sessions: z
    .object({
      recording: z.boolean().default(true),
      retentionDays: z.number().int().min(0).max(3650).default(30)
    })
    .default(() => ({ recording: true, retentionDays: 30 })),
  context: z
    .object({
      /** Estimated tokens after which a chat is considered long. */
      advisoryTokens: z.number().int().min(10_000).default(400_000),
      autoCompact: z.boolean().default(true),
      handoffPrompt: z.string().default(DEFAULT_HANDOFF_PROMPT)
    })
    .default(() => ({ advisoryTokens: 400_000, autoCompact: true, handoffPrompt: DEFAULT_HANDOFF_PROMPT })),
  agents: z
    .object({
      enabled: z.boolean().default(true),
      /** Simultaneously working workers per prime chat. */
      maxConcurrent: z.number().int().min(1).max(8).default(2),
      defaultModel: z.string().nullable().default(null),
      defaultReasoning: z.enum(REASONING_EFFORTS).nullable().default(null),
      /** Goal/Loop waits for a chat's own workers before deciding the next step. */
      waitForWorkers: z.boolean().default(false)
    })
    .default(() => ({ enabled: true, maxConcurrent: 2, defaultModel: null, defaultReasoning: null, waitForWorkers: false })),
  automation: z
    .object({
      /** Who decides Goal/Loop continuations: a ChatGPT helper chat or an OpenAI-compatible API. */
      backend: z.enum(['chatgpt', 'api']).default('chatgpt'),
      helperModel: z.string().default('gpt-6-thinking'),
      apiBaseUrl: z.string().default('https://openrouter.ai/api/v1'),
      apiModel: z.string().default('openai/gpt-5-mini'),
      /** Hard stop for automatic follow-ups per Goal/Loop activation. */
      maxSteps: z.number().int().min(1).max(500).default(25),
      /** Send "Continue" when a ChatGPT answer ends unfinished (error or cut off). */
      autoContinue: z.boolean().default(true),
      /** Expose `session_finish` so a model can hold the turn open for queued instructions. */
      finishTool: z.boolean().default(false)
    })
    .default(() => ({
      backend: 'chatgpt' as const,
      helperModel: 'gpt-6-thinking',
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      apiModel: 'openai/gpt-5-mini',
      maxSteps: 25,
      autoContinue: true,
      finishTool: false
    })),
  instructions: z
    .object({
      /** Standing instructions appended to the tool instructions sent with every new chat. */
      standing: z.string().default(''),
      /** Include the project's root AGENTS.md in a new chat's opening context. */
      includeAgentsMd: z.boolean().default(true)
    })
    .default(() => ({ standing: '', includeAgentsMd: true })),
  ui: z
    .object({
      theme: z.enum(['system', 'dark', 'light']).default('dark'),
      language: z.enum(['en', 'de']).default('en'),
      fontScale: z.number().min(0.8).max(1.4).default(1),
      defaultModel: z.string().nullable().default(null),
      defaultReasoning: z.enum(REASONING_EFFORTS).nullable().default(null),
      sidebarWidth: z.number().int().min(200).max(480).default(272),
      workPanelWidth: z.number().int().min(280).max(900).default(420),
      workPanelOpen: z.boolean().default(true),
      closeToTray: z.boolean().default(true),
      autoSelectSkills: z.boolean().default(false)
    })
    .default(() => ({
      theme: 'dark' as const,
      language: 'en' as const,
      fontScale: 1,
      defaultModel: null,
      defaultReasoning: null,
      sidebarWidth: 272,
      workPanelWidth: 420,
      workPanelOpen: true,
      closeToTray: true,
      autoSelectSkills: false
    })),
  controlApi: z
    .object({ enabled: z.boolean().default(false), allowActions: z.boolean().default(false) })
    .default(() => ({ enabled: false, allowActions: false })),
  plugins: z.array(pluginServerSchema).default([])
});

export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return configSchema.parse({});
}

/** Parses untrusted stored config; anything malformed falls back to defaults field by field where possible. */
export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  // Keep what validates at the top level so one bad field does not wipe the user's roots.
  const base = defaultConfig() as Record<string, unknown>;
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const field = (configSchema.shape as Record<string, z.ZodType>)[key];
      const parsed = field?.safeParse(value);
      if (parsed?.success) base[key] = parsed.data;
    }
  }
  return base as Config;
}

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Effective capabilities after read-only mode masks every mutating permission. */
export function effectiveCapabilities(config: Config): Capabilities {
  const caps = { ...config.capabilities };
  if (config.readOnly) {
    caps.write = caps.create = caps.delete = caps.move = caps.exec = false;
  }
  return caps;
}

/** Secret slots kept outside config.json, encrypted with the OS keychain. */
export const SECRET_KEYS = ['tunnelApiKey', 'automationApiKey'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number] | `plugin:${string}`;
