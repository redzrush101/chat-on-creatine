import type { BrowserWindow, WebContents } from 'electron';
import type { BrowserCapture } from './capture';

export interface Tab {
  id: string;
  window: BrowserWindow;
  wc: WebContents;
  /** Ref to DOM backendNodeId for the current document; reset on navigation. */
  refs: Map<string, number>;
  refIds: Map<number, string>;
  capture: BrowserCapture;
}

