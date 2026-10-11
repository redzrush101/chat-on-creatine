import { invoke } from './bridge';
import { reportError } from '../components/common/Toasts';

/** Opens a link in the default browser. */
export function openExternal(url: string): void {
  invoke('app:openExternal', url).catch(reportError);
}
