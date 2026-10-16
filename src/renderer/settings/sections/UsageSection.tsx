import { useState } from 'react';
import type { AppState } from '@shared/types';
import { contextUsage } from '@shared/context';
import { sessionBusy } from '@shared/session-state';
import { ContextUsage } from '../../components/composer/ContextUsage';
import { useSessionEvents } from '../../lib/store';
import { invoke } from '../../lib/bridge';
import { Button, Group, Row, SelectField, useRun } from '../controls';

export function UsageSection({ state, sessionId }: { state: AppState; sessionId: string | null }) {
  const chats = state.sessions.filter((session) => session.kind === 'chat');
  const [selected, setSelected] = useState(sessionId ?? chats[0]?.id ?? '');
  const session = chats.find((session) => session.id === selected) ?? chats[0];
  const events = useSessionEvents(session?.id ?? null);
  const act = useRun();
  const calls = events?.filter((event) => event.kind === 'tool') ?? [];
  return <div className="st-stack">
    <Group title="Account" description="Both interfaces share this ChatGPT login and local history.">
      <Row label="ChatGPT" hint={state.browser.signedIn ? 'Signed in' : 'Sign in to send messages'}>
        <Button onClick={() => act(() => invoke('browser:show', null))}>Open ChatGPT</Button>
      </Row>
    </Group>
    <Group title="Conversation usage" description="Inspect what is taking up context before continuing or compacting.">
      {session ? <>
        <Row label="Conversation"><SelectField label="Usage conversation" value={session.id} options={chats.map((chat) => ({ value: chat.id, label: chat.title }))} onChange={setSelected} /></Row>
        <div className="st-row is-stacked"><ContextUsage tokens={session.contextTokens} advisory={state.config.context.advisoryTokens} usage={session.contextUsage ?? (events ? contextUsage(events) : undefined)} /></div>
        <Row label="Completed turns" hint={String(events?.filter((event) => event.kind === 'turn' && event.phase === 'end').length ?? 0)} />
        <Row label="Tool calls" hint={`${calls.length} calls · ${calls.filter((call) => call.kind === 'tool' && call.status === 'error').length} errors`} />
        <Row label="Continue with a fresh context" hint="Keeps a handoff brief and the local transcript.">
          <Button disabled={sessionBusy(state, session.id)} onClick={() => act(() => invoke('chat:compact', session.id))}>Compact &amp; resume</Button>
        </Row>
      </> : <Row label="No conversations yet" hint="Usage appears after your first message." />}
    </Group>
  </div>;
}
