import { useState, type KeyboardEvent } from 'react';
import type { AutomationMode, InputDelivery } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { reportError, notify } from '../common/Toasts';
import type { ModelValue } from './ModelPicker';
import type { ComposerProps } from './types';
import { useComposerDraft } from './draft';

export const MODES: { value: AutomationMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Normal', hint: 'Plain chat' },
  { value: 'goal', label: 'Goal', hint: 'Keep working toward the objective until it is met' },
  { value: 'loop', label: 'Loop', hint: 'Repeat the brief in steps until stopped' }
];

export function useComposer({
  app,
  session,
  newChat,
  onNewChatChange,
  onCreated,
  onSubmitted,
  focusNonce,
  prefill
}: ComposerProps) {
  const sessionId = session?.id ?? null;
  const { text, setText, field } = useComposerDraft(sessionId, focusNonce, prefill);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const live = sessionId ? app.live[sessionId] : undefined;
  const busy = live !== undefined && live.turn !== 'idle';
  const mode: AutomationMode = session ? session.goal.mode : newChat.mode;
  const browserBlocked = app.browser.signedIn === false || !app.browser.ready;
  const toolsOffline = app.connection.state !== 'connected';
  const inputs = sessionId ? app.inputs.filter((item) => item.sessionId === sessionId && (item.state === 'queued' || item.state === 'sending' || item.state === 'failed')) : [];
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending;

  const attach = () => {
    invoke('app:pickFiles')
      .then((paths) => setAttachments((current) => [...new Set([...current, ...paths])]))
      .catch(reportError);
  };

  const setMode = (next: AutomationMode) => {
    if (!session) {
      onNewChatChange({ mode: next });
      return;
    }
    invoke('chat:setAutomation', session.id, next, next === 'off' ? undefined : session.goal.objective || undefined).catch(reportError);
  };

  const submit = async (delivery: InputDelivery) => {
    const body = text.trim();
    if (!canSend || (browserBlocked && !busy)) return;
    if (mode !== 'off' && !busy && !body) {
      notify('Write the objective first, then send.', 'info');
      return;
    }
    setSending(true);
    try {
      // Goal and Loop start with the message as objective; while a turn runs, sends are plain steers or queued messages.
      const automation = mode !== 'off' && !busy ? mode : undefined;
      const result = await invoke('chat:send', {
        sessionId: session?.id ?? null,
        text: body,
        attachments,
        delivery: session && busy ? delivery : 'now',
        automation,
        ...(!session ? { projectId: newChat.projectId, model: newChat.model.model, reasoning: newChat.model.reasoning } : {})
      });
      setText('');
      setAttachments([]);
      if (session) onSubmitted();
      else onCreated(result.sessionId);
    } catch (error) {
      reportError(error);
    } finally {
      setSending(false);
    }
  };

  const stop = () => {
    if (sessionId) invoke('chat:stop', sessionId).catch(reportError);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // While a turn runs, Enter queues for after it; Ctrl/Cmd+Enter steers into the current turn.
      void submit(busy && !(event.metaKey || event.ctrlKey) ? 'after-turn' : 'now');
    } else if (event.key === 'Escape' && busy) {
      event.preventDefault();
      stop();
    }
  };

  const modelValue: ModelValue = session ? { model: session.model, reasoning: session.reasoning } : newChat.model;
  const modelChange = (value: ModelValue) => {
    if (session) invoke('sessions:update', session.id, { model: value.model, reasoning: value.reasoning }).catch(reportError);
    else onNewChatChange({ model: value });
  };

  const placeholder = busy
    ? 'Steer or queue a message…'
    : mode === 'goal'
      ? 'Describe the goal…'
      : mode === 'loop'
        ? 'Describe what the loop should do…'
        : session
          ? 'Message ChatGPT'
          : 'What should we work on?';

  return { sessionId, text, setText, field, attachments, setAttachments, busy, mode, browserBlocked, toolsOffline, inputs, canSend, attach, setMode, submit, stop, onKeyDown, modelValue, modelChange, placeholder };
}
