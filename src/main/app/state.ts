import { app } from 'electron';
import type { AppState, BrowserStatus, SessionEvent } from '@shared/types';
import type { MainEvent, MainEvents } from '@shared/ipc';
import type { Services } from './services';
import { createLogger } from '../core/log';

const STATE_COALESCE_MS = 50;

/** Assembles AppState from the services and pushes it (and history upserts) to the renderer. */
export class StateHub {
  private stateTimer: NodeJS.Timeout | null = null;
  private eventsTimer: NodeJS.Immediate | null = null;
  private stateChanged = false;
  private readonly pendingEvents = new Map<string, Map<string, SessionEvent>>();

  constructor(
    private readonly services: () => Services | null,
    private readonly send: <E extends MainEvent>(event: E, payload: MainEvents[E]) => void
  ) {}

  async snapshot(): Promise<AppState> {
    const s = this.services();
    if (!s) throw new Error('App is starting');
    const tools = await s.connection.tools();
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
    return {
      version: app.getVersion(),
      platform: process.platform,
      config: s.config.get(),
      connection: s.connection.status(),
      browser,
      models: s.models.get(),
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
    this.stateChanged = true;
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      if (!this.services()) { this.stateTimer = null; return; }
      this.stateChanged = false;
      void this.snapshot().then((state) => this.send('state', state))
        .catch((error: unknown) => createLogger('state').error('could not assemble app state', error))
        .finally(() => { this.stateTimer = null; if (this.stateChanged) this.changed(); });
    }, STATE_COALESCE_MS);
  }

  events(sessionId: string, events: SessionEvent[]): void {
    let pending = this.pendingEvents.get(sessionId);
    if (!pending) this.pendingEvents.set(sessionId, (pending = new Map()));
    for (const event of events) pending.set(event.id, event);
    if (this.eventsTimer) return;
    this.eventsTimer = setImmediate(() => {
      this.eventsTimer = null;
      const batches = [...this.pendingEvents];
      this.pendingEvents.clear();
      for (const [id, batch] of batches) this.send('session:events', { sessionId: id, events: [...batch.values()] });
    });
  }
}
