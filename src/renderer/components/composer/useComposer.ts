import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { AutomationMode, CodingTask, InputDelivery } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { reportError, notify } from '../common/Toasts';
import type { ModelSelection } from '@shared/types';
import type { ComposerProps } from './types';
import { useComposerDraft } from './draft';
import { sessionBusy } from '@shared/session-state';
import { findModel, modelSelection } from '@shared/model-selection';

export const MODES: { value: AutomationMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Normal', hint: 'One answer per message' },
  { value: 'goal', label: 'Goal', hint: 'Keep working toward the objective until it is met' },
  { value: 'loop', label: 'Loop', hint: 'Repeat the brief in steps until stopped' }
];

export function useComposer({
  app,
  session,
  activity,
  newChat,
  onNewChatChange,
  onCreated,
  onSubmitted,
  focusNonce,
  prefill,
  rootDir
}: ComposerProps) {
  const sessionId = session?.id ?? null;
  const { text, setText, field } = useComposerDraft(sessionId, focusNonce, prefill);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [clipboardPaste, setClipboardPaste] = useState<Promise<string[]> | null>(null);

  const busy = sessionBusy(app, sessionId);
  const canStop = busy || activity?.active === true;
  const mode: AutomationMode = session ? session.goal.mode : newChat.mode;
  const browserBlocked = app.browser.signedIn === false || !app.browser.ready;
  const toolsOffline = app.connection.state !== 'connected';
  const inputs = sessionId ? app.inputs.filter((item) => item.sessionId === sessionId && (item.state === 'queued' || item.state === 'sending' || item.state === 'failed')) : [];
  const canSend = (text.trim().length > 0 || attachments.length > 0 || clipboardPaste !== null) && !sending;
  const workflowDisabled = canStop || sending || browserBlocked || toolsOffline || inputs.some((input) => input.state === 'queued' || input.state === 'sending');
  const taskCwd = rootDir ?? (session ? session.cwd : app.projects.find((project) => project.id === newChat.projectId)?.path) ?? app.config.roots[0]?.path ?? null;

  const attach = () => {
    invoke('app:pickFiles')
      .then((paths) => setAttachments((current) => [...new Set([...current, ...paths])]))
      .catch(reportError);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (![...event.clipboardData.items].some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return;
    event.preventDefault();
    const pending = Promise.all([clipboardPaste, invoke('app:clipboard')]).then(([earlier, { imagePath }]) => {
      if (!imagePath) throw new Error('The clipboard no longer contains an image. Copy it again and paste.');
      setAttachments((current) => [...new Set([...current, imagePath])]);
      return [...(earlier ?? []), imagePath];
    });
    setClipboardPaste(pending);
    const clear = () => setClipboardPaste((current) => current === pending ? null : current);
    void pending.then(clear, (error: unknown) => { reportError(error); clear(); });
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
      const pasted = await clipboardPaste;
      const files = [...new Set([...attachments, ...(pasted ?? [])])];
      // Goal and Loop start with the message as objective; while a turn runs, sends are plain steers or queued messages.
      const automation = mode !== 'off' && !busy ? mode : undefined;
      const result = await invoke('chat:send', {
        sessionId: session?.id ?? null,
        text: body,
        attachments: files,
        delivery: session && busy ? delivery : 'now',
        ...(!session && taskCwd ? { cwd: taskCwd } : {}),
        automation,
        ...(!session ? { projectId: newChat.projectId, model: newChat.model.model, reasoning: newChat.model.reasoning } : {})
      });
      setText((current) => current === text ? '' : current);
      setAttachments((current) => current.filter((path) => !files.includes(path)));
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

  const runTask = async (task: CodingTask, focus: string): Promise<boolean> => {
    if (workflowDisabled || !taskCwd) return false;
    setSending(true);
    try {
      const result = await invoke('chat:send', {
        sessionId, cwd: taskCwd, text: focus, task, attachments: [], delivery: 'now',
        ...(!session ? { projectId: newChat.projectId, model: newChat.model.model, reasoning: newChat.model.reasoning } : {})
      });
      if (session) onSubmitted();
      else { onNewChatChange({ mode: 'off' }); onCreated(result.sessionId); }
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.ctrlKey && event.key.toLowerCase() === 'p' || event.shiftKey && event.key === 'Tab') {
      event.preventDefault();
      if (busy) { notify('Stop the current turn before changing models.', 'info'); return; }
      const current = findModel(app.models.models, modelValue.model ?? app.models.defaultModel);
      if (event.key === 'Tab') {
        const efforts = current?.efforts ?? [];
        const next = efforts[(efforts.findIndex((level) => level === modelValue.reasoning) + 1) % efforts.length];
        if (current && next) modelChange(modelSelection(current, next));
      } else {
        const next = app.models.models[(app.models.models.findIndex((model) => model === current) + 1) % app.models.models.length];
        if (next) modelChange(modelSelection(next, modelValue.reasoning));
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // While a turn runs, Enter queues for after it; Ctrl/Cmd+Enter steers into the current turn.
      void submit(busy && !(event.metaKey || event.ctrlKey) ? 'after-turn' : 'now');
    } else if (event.key === 'Escape' && canStop) {
      event.preventDefault();
      stop();
    }
  };

  const modelValue: ModelSelection = session ? { model: session.model, reasoning: session.reasoning } : newChat.model;
  const modelChange = (value: ModelSelection) => {
    void invoke('chat:selectModel', sessionId, value).then((model) => { if (!session) onNewChatChange({ model }); }).catch(reportError);
  };

  const placeholder = busy
    ? 'Steer or queue a message…'
    : mode === 'goal'
      ? 'Describe the goal…'
      : mode === 'loop'
        ? 'Describe what the loop should do…'
        : session
          ? 'Reply to ChatGPT…'
          : 'How can I help you today?';

  return { sessionId, text, setText, field, attachments, setAttachments, busy, canStop, mode, browserBlocked, toolsOffline, inputs, canSend, attach, setMode, submit, stop, runTask, workflowDisabled, taskCwd, onKeyDown, onPaste, modelValue, modelChange, placeholder };
}
