import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, CircleAlert, Paperclip, Plug, Square, WifiOff, X } from 'lucide-react';
import type { AppState, AutomationMode, InputDelivery, SessionMeta } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { basename, cx } from '../../lib/format';
import { reportError, notify } from '../common/Toasts';
import { Banner } from '../common/Banner';
import { ModelPicker, type ModelValue } from './ModelPicker';
import { PendingInputs } from './PendingInputs';

/** Settings for the chat that does not exist yet; kept by the app while the empty state shows. */
export interface NewChatDraft {
  projectId: string | null;
  model: ModelValue;
  mode: AutomationMode;
}

interface ComposerProps {
  app: AppState;
  /** Null composes the first message of a new chat. */
  session: SessionMeta | null;
  newChat: NewChatDraft;
  onNewChatChange(patch: Partial<NewChatDraft>): void;
  onCreated(sessionId: string): void;
  onSubmitted(): void;
  onOpenSettings(section?: string): void;
  focusNonce: number;
  /** Text placed into the field (starter suggestions); applied each time `id` changes. */
  prefill?: { id: number; text: string };
  hero?: boolean;
}

const MODES: { value: AutomationMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Normal', hint: 'Plain chat' },
  { value: 'goal', label: 'Goal', hint: 'Keep working toward the objective until it is met' },
  { value: 'loop', label: 'Loop', hint: 'Repeat the brief in steps until stopped' }
];

const MAX_INPUT_HEIGHT = 240;

function draftKey(sessionId: string | null): string {
  return `creatine.draft.${sessionId ?? 'new'}`;
}

function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the draft lives only until the composer unmounts.
  }
}

export function Composer({
  app,
  session,
  newChat,
  onNewChatChange,
  onCreated,
  onSubmitted,
  onOpenSettings,
  focusNonce,
  prefill,
  hero
}: ComposerProps) {
  const sessionId = session?.id ?? null;
  const key = draftKey(sessionId);
  const [text, setText] = useState(() => readDraft(key));
  const [attachments, setAttachments] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  const live = sessionId ? app.live[sessionId] : undefined;
  const busy = live !== undefined && live.turn !== 'idle';
  const mode: AutomationMode = session ? session.goal.mode : newChat.mode;
  const browserBlocked = app.browser.signedIn === false || !app.browser.ready;
  const toolsOffline = app.connection.state !== 'connected';
  const inputs = sessionId ? app.inputs.filter((item) => item.sessionId === sessionId && (item.state === 'queued' || item.state === 'sending' || item.state === 'failed')) : [];
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending;

  useEffect(() => {
    writeDraft(key, text);
  }, [key, text]);

  useEffect(() => {
    field.current?.focus();
  }, [focusNonce]);

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    field.current?.focus();
  }, [prefill]);

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text]);

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
      if (session) {
        await invoke('chat:send', {
          sessionId: session.id,
          text: body,
          attachments,
          delivery: busy ? delivery : 'now',
          automation
        });
        setText('');
        setAttachments([]);
        onSubmitted();
      } else {
        const result = await invoke('chat:send', {
          sessionId: null,
          text: body,
          attachments,
          delivery: 'now',
          projectId: newChat.projectId,
          model: newChat.model.model,
          reasoning: newChat.model.reasoning,
          automation
        });
        setText('');
        setAttachments([]);
        onCreated(result.sessionId);
      }
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

  return (
    <div className={cx('composer-wrap', hero && 'is-hero')}>
      {browserBlocked && (
        <Banner
          tone="warning"
          icon={<CircleAlert size={14} />}
          action={
            app.browser.signedIn === false
              ? { label: 'Sign in to ChatGPT', onClick: () => invoke('browser:signIn').catch(reportError) }
              : { label: 'Show ChatGPT', onClick: () => invoke('browser:show', sessionId).catch(reportError) }
          }
        >
          {app.browser.signedIn === false
            ? 'Not signed in to ChatGPT. Sign in before sending.'
            : 'ChatGPT is not ready yet. Messages cannot be sent until it is.'}
        </Banner>
      )}
      {!browserBlocked && toolsOffline && !hero && (
        <Banner
          tone="info"
          icon={<WifiOff size={14} />}
          action={{ label: 'Open connection', onClick: () => onOpenSettings('connection') }}
        >
          Local tools are offline. Chats still run, but ChatGPT cannot reach this computer.
        </Banner>
      )}
      {inputs.length > 0 && <PendingInputs inputs={inputs} />}

      <div className="composer">
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((path) => (
              <span key={path} className="file-chip" title={path}>
                <Paperclip size={12} aria-hidden="true" />
                <span className="file-chip-name">{basename(path)}</span>
                <button
                  type="button"
                  className="icon-btn file-chip-remove"
                  aria-label={`Remove ${basename(path)}`}
                  onClick={() => {
                    setAttachments((current) => current.filter((item) => item !== path));
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={field}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          spellCheck
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bar">
          <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files" onClick={attach}>
            <Paperclip size={15} />
          </button>
          <ModelPicker value={modelValue} catalog={app.models} onChange={modelChange} />
          <div className="segmented" role="group" aria-label="Mode">
            {MODES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={cx('segmented-item', mode === item.value && 'is-active')}
                aria-pressed={mode === item.value}
                title={item.hint}
                onClick={() => setMode(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="composer-spacer" />
          {busy && sessionId ? (
            <>
              <button
                type="button"
                className="btn btn-small"
                disabled={!canSend}
                title="Queue: sent after this turn (Enter)"
                onClick={() => void submit('after-turn')}
              >
                Queue
              </button>
              <button
                type="button"
                className="btn btn-small btn-primary"
                disabled={!canSend}
                title="Steer: reaches the model with its next tool result (Ctrl/Cmd+Enter)"
                onClick={() => void submit('now')}
              >
                Steer
              </button>
              <button type="button" className="icon-btn btn-stop" aria-label="Stop" title="Stop generating (Esc)" onClick={stop}>
                <Square size={12} fill="currentColor" />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="icon-btn btn-send"
              aria-label="Send"
              title={browserBlocked ? 'Sign in to ChatGPT to send' : 'Send (Enter)'}
              disabled={!canSend || browserBlocked}
              onClick={() => void submit('now')}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      <p className="composer-hint">
        {mode !== 'off' && !busy ? MODES.find((item) => item.value === mode)?.hint : 'Enter sends · Shift+Enter for a new line'}
        {toolsOffline && hero && (
          <button type="button" className="link-btn" onClick={() => onOpenSettings('connection')}>
            <Plug size={11} aria-hidden="true" /> Local tools offline
          </button>
        )}
      </p>
    </div>
  );
}
