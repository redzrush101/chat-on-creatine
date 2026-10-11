import type { SecretKey } from '@shared/config';
import { readJsonSync, writeJson } from './durable';
import { createLogger } from './log';

const log = createLogger('secrets');

/** Encrypts with the OS keychain (Electron safeStorage) when available. */
export interface Cipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

interface StoredSecret {
  /** `safe` = safeStorage base64; `plain` = only when no keychain exists (logged loudly). */
  enc: 'safe' | 'plain';
  value: string;
}

/**
 * Credentials live here, never in config.json, logs or IPC payloads. The renderer can set a value
 * and learn which keys are set; it can never read one back.
 */
export class SecretStore {
  private readonly data: Record<string, StoredSecret>;

  constructor(private readonly path: string, private readonly cipher: Cipher) {
    this.data = readJsonSync<Record<string, StoredSecret>>(path, {});
  }

  /** Re-encrypts values stored in plain text while no keychain was available. Call after app ready. */
  upgrade(): void {
    if (!this.cipher.available()) return;
    const plain = Object.entries(this.data).filter(([, stored]) => stored.enc === 'plain');
    if (!plain.length) return;
    for (const [key, stored] of plain) this.data[key] = { enc: 'safe', value: this.cipher.encrypt(stored.value) };
    void writeJson(this.path, this.data);
    log.info(`encrypted ${plain.length} stored secret(s) with the OS keychain`);
  }

  get(key: SecretKey): string | null {
    const stored = this.data[key];
    if (!stored) return null;
    try {
      return stored.enc === 'safe' ? this.cipher.decrypt(stored.value) : stored.value;
    } catch (error) {
      log.error(`cannot decrypt ${key}`, error);
      return null;
    }
  }

  set(key: SecretKey, value: string | null): void {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) {
      delete this.data[key];
    } else if (this.cipher.available()) {
      this.data[key] = { enc: 'safe', value: this.cipher.encrypt(trimmed) };
    } else {
      log.warn(`OS keychain unavailable; ${key} is stored unencrypted in the user data folder`);
      this.data[key] = { enc: 'plain', value: trimmed };
    }
    void writeJson(this.path, this.data);
  }

  keys(): string[] {
    return Object.keys(this.data);
  }
}
