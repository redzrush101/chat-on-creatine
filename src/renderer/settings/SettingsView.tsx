import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { ArrowLeft, Code2, FileText, FolderOpen, Globe, History, Info, Palette, Plug, Puzzle, Rocket, Search, Sparkles, Users, X } from 'lucide-react';
import type { AppState } from '@shared/types';
import { useAppState } from '../lib/store';
import { Button, ReportContext } from './controls';
import { SetupSection } from './sections/SetupSection';
import { WorkspaceSection } from './sections/WorkspaceSection';
import { ConnectionSection } from './sections/ConnectionSection';
import { ChatGptSection } from './sections/ChatGptSection';
import { AgentsSection } from './sections/AgentsSection';
import { ContextSection } from './sections/ContextSection';
import { InstructionsSection } from './sections/InstructionsSection';
import { SkillsSection } from './sections/SkillsSection';
import { PluginsSection } from './sections/PluginsSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { DeveloperSection } from './sections/DeveloperSection';
import { AboutSection } from './sections/AboutSection';
import './settings.css';

type SectionId =
  | 'setup'
  | 'workspace'
  | 'connection'
  | 'chatgpt'
  | 'agents'
  | 'context'
  | 'instructions'
  | 'skills'
  | 'plugins'
  | 'appearance'
  | 'developer'
  | 'about';

interface SectionDef {
  id: SectionId;
  label: string;
  icon: typeof Rocket;
  keywords: string;
  render(props: { state: AppState }): JSX.Element;
}

const SECTIONS: readonly SectionDef[] = [
  { id: 'setup', label: 'Setup', icon: Rocket, keywords: 'tunnel connect sign in folder connector start', render: (p) => <SetupSection {...p} /> },
  { id: 'workspace', label: 'Workspace', icon: FolderOpen, keywords: 'folders roots capabilities read write exec command policy read-only', render: (p) => <WorkspaceSection {...p} /> },
  { id: 'connection', label: 'Connection', icon: Plug, keywords: 'tunnel api key port connector cloudflare manual', render: (p) => <ConnectionSection {...p} /> },
  { id: 'chatgpt', label: 'ChatGPT', icon: Globe, keywords: 'browser model reasoning sign in extension window usage', render: (p) => <ChatGptSection {...p} /> },
  { id: 'agents', label: 'Agents', icon: Users, keywords: 'workers automation goal loop api helper steps', render: (p) => <AgentsSection {...p} /> },
  { id: 'context', label: 'Context & history', icon: History, keywords: 'recording retention compact handoff tokens history', render: (p) => <ContextSection {...p} /> },
  { id: 'instructions', label: 'Instructions', icon: FileText, keywords: 'standing AGENTS.md prompt', render: (p) => <InstructionsSection {...p} /> },
  { id: 'skills', label: 'Skills', icon: Sparkles, keywords: 'import skill SKILL.md', render: (p) => <SkillsSection {...p} /> },
  { id: 'plugins', label: 'Plugins', icon: Puzzle, keywords: 'mcp server tools stdio http', render: (p) => <PluginsSection {...p} /> },
  { id: 'appearance', label: 'Appearance', icon: Palette, keywords: 'theme language font scale tray', render: (p) => <AppearanceSection {...p} /> },
  { id: 'developer', label: 'Developer', icon: Code2, keywords: 'control api logs debug actions', render: (p) => <DeveloperSection {...p} /> },
  { id: 'about', label: 'About', icon: Info, keywords: 'version platform', render: (p) => <AboutSection {...p} /> }
];

function toSection(value: string | undefined): SectionId {
  return SECTIONS.find((section) => section.id === value)?.id ?? 'setup';
}

export function SettingsView({ onClose, section }: { onClose(): void; section?: string }): JSX.Element {
  const state = useAppState();
  const [active, setActive] = useState<SectionId>(() => toSection(section));
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (section !== undefined) setActive(toSection(section));
  }, [section]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return SECTIONS;
    return SECTIONS.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(needle));
  }, [query]);

  const current = SECTIONS.find((item) => item.id === active) ?? SECTIONS[0]!;

  return (
    <ReportContext.Provider value={setError}>
      <div className="st-root">
        <nav className="st-nav" aria-label="Settings sections">
          <Button variant="ghost" className="st-back" onClick={onClose}>
            <ArrowLeft size={15} aria-hidden /> Back to chats
          </Button>
          <label className="st-search">
            <Search size={14} aria-hidden />
            <input
              type="search"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            className="st-nav-select"
            aria-label="Settings section"
            value={current.id}
            onChange={(event) => setActive(toSection(event.target.value))}
          >
            {visible.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <ul className="st-nav-list">
            {visible.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={item.id === active ? 'st-nav-item is-active' : 'st-nav-item'}
                    aria-current={item.id === active ? 'page' : undefined}
                    onClick={() => setActive(item.id)}
                  >
                    <Icon size={15} aria-hidden />
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            })}
            {visible.length === 0 && <li className="st-nav-empty">No matching sections</li>}
          </ul>
        </nav>

        <main className="st-main">
          <header className="st-main-head">
            <h1>{current.label}</h1>
          </header>
          {error && (
            <div className="st-banner" role="alert">
              <span>{error}</span>
              <Button variant="ghost" aria-label="Dismiss" onClick={() => setError(null)}>
                <X size={14} aria-hidden />
              </Button>
            </div>
          )}
          <div className="st-content">
            {state ? current.render({ state }) : <p className="st-muted">Loading settings…</p>}
          </div>
        </main>
      </div>
    </ReportContext.Provider>
  );
}
