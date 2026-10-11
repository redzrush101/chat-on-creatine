/**
 * Page driver: runs inside a chatgpt.com page, observes the conversation stream relayed by the
 * fetch tap, watches the composer state and executes commands from the app.
 */
import {
  conversationIdFromUrl,
  DRIVER_VERSION,
  type PageCommand,
  type PageEvent,
  type PageResult
} from '@shared/page-protocol';
import { createBackend } from './backend';
import { PageCommands } from './commands';
import { observePage } from './observe';
import { StreamRelay, type TapMessage } from './streams';

interface DriverTransport {
  send(event: PageEvent): void;
  onCommand(handler: (command: PageCommand) => Promise<PageResult>): void;
}

/**
 * Starts the driver in the current page. Call once per document; the tap must already be
 * installed on `tapChannel`.
 */
export function startDriver(transport: DriverTransport, tapChannel: string): void {
  const emit = (event: PageEvent): void => transport.send(event);
  const backend = createBackend();
  const streams = new StreamRelay(emit, () => conversationIdFromUrl(location.href));
  const commands = new PageCommands(backend, streams);

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as TapMessage | null;
    if (!data || typeof data !== 'object' || data.channel !== tapChannel) return;
    streams.handle(data);
  });

  async function refreshAuth(): Promise<void> {
    const current = await backend.getSession(true);
    if (current) emit({ type: 'auth', signedIn: current.signedIn, email: current.email });
  }

  const checkPage = observePage(emit);

  transport.onCommand((command) => commands.run(command));
  emit({
    type: 'hello',
    driverVersion: DRIVER_VERSION,
    url: location.href,
    conversationId: conversationIdFromUrl(location.href),
    signedIn: null
  });
  void refreshAuth();
  checkPage();
}
