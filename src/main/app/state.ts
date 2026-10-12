import { app } from 'electron';
import type { AppState, BrowserStatus, SessionEvent } from '@shared/types';
import type { MainEvent, MainEvents } from '@shared/ipc';
import type { Services } from './services';

const STATE_COALESCE_MS = 50;
const EVENTS_COALESCE_MS = 80;

/** Assembles AppState from the services and pushes it (and history upserts) to the renderer. */
export class StateHub {
  private stateTimer: NodeJS.Timeout | null = null;
  private eventsTimer: NodeJS.Timeout | null = null;
  private readonly pendingEvents = new Map<string, Map<string, SessionEvent>>();

  constructor(
    private readonly services: () => Services | null,
    private readonly send: <E extends MainEvent>(event: E, payload: MainEvents[E]) => void
  ) {}

  snapshot(): AppState {
    const s = this.services();
    if (!s) throw new Error('App is starting');
    const hostStatus = s.host.status();
    const browser: BrowserStatus = {
      ready: hostStatus.ready,
      signedIn: hostStatus.signedIn,
      openTabs: s.host.tabs().length,
      windowVisible: hostStatus.windowVisible,
      detail: hostStatus.detail
    };
    const live = s.router.liveState();
    for (const sessionId of s.compacting) {
      const current = live[sessionId] ?? { sessionId, turn: 'idle', tabOpen: false, runningTools: 0, lastActivityAt: null };
      if (current.turn === 'idle') live[sessionId] = { ...current, turn: 'compacting' };
    }
    const tools = s.connection.tools();
    return {
      version: app.getVersion(),
      platform: process.platform,
      config: s.config.get(),
      connection: s.connection.status(),
      browser,
      models: s.models.get(),
      usage: { summary: null, fetchedAt: null },
      sessions: s.store.list(),
      live,
      inputs: s.outbox.list(),
      projects: s.projects.list(),
      agents: s.agents.runs(),
      skills: s.skills.list(),
      plugins: s.plugins.status(),
      secretsSet: s.secrets.keys(),
      tools: { tunnelClient: tools.tunnelClient, cloudflared: tools.cloudflared, ripgrep: null }
    };
  }

  /** Coalesces bursts (streaming deltas) into one push. */
  changed(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.services()) this.send('state', this.snapshot());
    }, STATE_COALESCE_MS);
  }

  events(sessionId: string, events: SessionEvent[]): void {
    let pending = this.pendingEvents.get(sessionId);
    if (!pending) this.pendingEvents.set(sessionId, (pending = new Map()));
    for (const event of events) pending.set(event.id, event);
    if (this.eventsTimer) return;
    this.eventsTimer = setTimeout(() => {
      this.eventsTimer = null;
      for (const [id, batch] of this.pendingEvents) this.send('session:events', { sessionId: id, events: [...batch.values()] });
      this.pendingEvents.clear();
    }, EVENTS_COALESCE_MS);
  }
}
