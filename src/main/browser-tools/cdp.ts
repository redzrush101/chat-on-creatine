import type { WebContents } from 'electron';
import type { AxNode } from './snapshot-format';

export const CDP_TIMEOUT_MS = 25_000;

export interface RemoteObject {
  type: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

interface ExceptionDetails {
  exception?: RemoteObject;
  text: string;
  url?: string;
}

export type CdpEvent =
  | { method: 'Runtime.consoleAPICalled'; params: { type: string; args?: RemoteObject[]; stackTrace?: { callFrames?: { url: string }[] } } }
  | { method: 'Runtime.exceptionThrown'; params: { exceptionDetails: ExceptionDetails } }
  | { method: 'Log.entryAdded'; params: { entry: { level: string; text: string; url?: string } } }
  | { method: 'Network.requestWillBeSent'; params: { requestId: string; request: { method: string; url: string }; type?: string } }
  | { method: 'Network.responseReceived'; params: { requestId: string; response: { status: number; mimeType: string } } }
  | { method: 'Network.loadingFailed'; params: { requestId: string; errorText: string } }
  | { method: 'Network.loadingFinished'; params: { requestId: string } }
  | { method: 'Page.frameNavigated'; params: { frame: { parentId?: string } } };

type EvaluationResult = { result: RemoteObject; exceptionDetails?: ExceptionDetails };
interface CdpResults {
  'Accessibility.getFullAXTree': { nodes: AxNode[] };
  'Page.getLayoutMetrics': { cssContentSize: { width: number; height: number }; cssVisualViewport: { clientWidth: number; clientHeight: number } };
  'Page.captureScreenshot': { data: string };
  'DOM.resolveNode': { object: RemoteObject };
  'DOM.getBoxModel': { model: { content: [number, number, number, number, number, number, number, number] } };
  'Runtime.evaluate': EvaluationResult;
  'Runtime.callFunctionOn': EvaluationResult;
  'Network.getResponseBody': { body: string; base64Encoded: boolean };
}

type CdpResult<M extends string> = M extends keyof CdpResults ? CdpResults[M] : unknown;

export function send<M extends string>(tab: { wc: WebContents }, method: M, params?: object): Promise<CdpResult<M>> {
  // Electron leaves CDP results untyped; the method fixes their shape at this boundary.
  return withTimeout(tab.wc.debugger.sendCommand(method, params), CDP_TIMEOUT_MS, method) as Promise<CdpResult<M>>;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out.`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export async function viewportSize(tab: { wc: WebContents }): Promise<{ width: number; height: number }> {
  const metrics = await send(tab, 'Page.getLayoutMetrics');
  return { width: Math.round(metrics.cssVisualViewport.clientWidth), height: Math.round(metrics.cssVisualViewport.clientHeight) };
}
