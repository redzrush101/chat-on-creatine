import type { SurfaceId } from '@shared/types';

export const SURFACE_IDS: readonly SurfaceId[] = ['core', 'desktop', 'plugins'];

export const CONNECTOR_BRAND = 'Chat on Creatine';
const CONNECTOR_SUFFIX_MAX = 32;
/** Letters, digits, spaces, dots, dashes and underscores; the app adds the parentheses. */
const CONNECTOR_SUFFIX_PATTERN = /^[\p{L}\p{N} ._-]*$/u;

interface SurfaceDefinition {
  id: SurfaceId;
  /** MCP server name. Stable: ChatGPT keys its cached metadata off it. */
  serverName: string;
  /** Word after the brand in the connector name. */
  word: 'Core' | 'Desktop' | 'Plugins';
  /**
   * Exactly what the user pastes as the connector description. Written as vocabulary: before any
   * discovery the model sees only the name and this sentence, and decides from them whether to
   * pull this surface's schemas at all.
   */
  description: string;
  cardSummary: string;
  /** Core is required; the others are opt-in. */
  required: boolean;
}

export const SURFACES: Record<SurfaceId, SurfaceDefinition> = {
  core: {
    id: 'core',
    serverName: 'chat-on-creatine-core',
    word: 'Core',
    description:
      'Read and edit code and text files on this computer, and run commands in a real terminal. ' +
      'Use for: opening and reading files, searching a repository, applying patches, creating, renaming and deleting files, ' +
      'running builds, tests, linters, git, npm and shell commands, continuing long-running or interactive terminal sessions, ' +
      'and saving images and files ChatGPT generates onto this computer. ' +
      'Also displays task plans and, when enabled, spawns and coordinates worker agents across several ChatGPT conversations.',
    cardSummary: 'Files, patches and terminal.',
    required: true
  },
  desktop: {
    id: 'desktop',
    serverName: 'chat-on-creatine-desktop',
    word: 'Desktop',
    description:
      'Control web browser tabs in the background. ' +
      'Attach existing Chrome, Edge or Brave tabs or open new tabs; inspect DOM refs, page screenshots, JavaScript, console errors and network requests; ' +
      'click, fill forms, navigate and scroll without foreground activation. ' +
      'Use for: reading and testing web pages, debugging front-end behaviour, and automating the browser the user already signed in to.',
    cardSummary: 'Browser tabs through the companion extension.',
    required: false
  },
  plugins: {
    id: 'plugins',
    serverName: 'chat-on-creatine-plugins',
    word: 'Plugins',
    description:
      'Tools from external MCP integrations installed and enabled in Chat on Creatine Settings, including Blender and other connected applications and services.',
    cardSummary: 'One shared connector for your enabled external MCP plugins.',
    required: false
  }
};

/** A usable suffix, or '' for anything empty, too long or outside the allowed characters. */
function normalizeConnectorSuffix(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length <= CONNECTOR_SUFFIX_MAX && CONNECTOR_SUFFIX_PATTERN.test(trimmed) ? trimmed : '';
}

/**
 * The name the user types into ChatGPT. ChatGPT records tool calls under this exact name, so the
 * app must recognise its own connectors by it, which is why the suffix is part of the name.
 */
export function connectorName(surface: SurfaceId, suffix: unknown = ''): string {
  const plain = `${CONNECTOR_BRAND} ${SURFACES[surface].word}`;
  const tag = normalizeConnectorSuffix(suffix);
  return tag ? `${plain} (${tag})` : plain;
}
