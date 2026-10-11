import { ArrowUp, CircleAlert, Paperclip, Plug, Square, WifiOff, X } from 'lucide-react';
import { invoke } from '../../lib/bridge';
import { basename, cx } from '../../lib/format';
import { reportError } from '../common/Toasts';
import { Banner } from '../common/Banner';
import { ModelPicker } from './ModelPicker';
import { PendingInputs } from './PendingInputs';
import { MODES, useComposer } from './useComposer';
import type { ComposerProps } from './types';

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
  const {
    sessionId, text, setText, field, attachments, setAttachments, busy, mode, browserBlocked,
    toolsOffline, inputs, canSend, attach, setMode, submit, stop, onKeyDown, modelValue, modelChange, placeholder
  } = useComposer({ app, session, newChat, onNewChatChange, onCreated, onSubmitted, onOpenSettings, focusNonce, prefill });

  return (
    <div className={cx('composer-wrap', hero && 'is-hero')}>
      <ComposerStatus app={app} hero={hero} onOpenSettings={onOpenSettings} sessionId={sessionId} browserBlocked={browserBlocked} toolsOffline={toolsOffline} inputs={inputs} />

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
          <ComposerActions busy={busy} sessionId={sessionId} canSend={canSend} browserBlocked={browserBlocked} submit={submit} stop={stop} />
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

function ComposerActions({ busy, sessionId, canSend, browserBlocked, submit, stop }: Pick<ReturnType<typeof useComposer>, 'busy' | 'sessionId' | 'canSend' | 'browserBlocked' | 'submit' | 'stop'>) {
  return (
    <>
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
    </>
  );
}

function ComposerStatus({ app, hero, onOpenSettings, sessionId, browserBlocked, toolsOffline, inputs }: Pick<ComposerProps, 'app' | 'hero' | 'onOpenSettings'> & Pick<ReturnType<typeof useComposer>, 'sessionId' | 'browserBlocked' | 'toolsOffline' | 'inputs'>) {
  return (
    <>
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
    </>
  );
}
