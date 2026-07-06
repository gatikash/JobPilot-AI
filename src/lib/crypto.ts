// Data-at-rest encryption with an automatic key: AES-256-GCM under a random
// key generated on first run and persisted in chrome.storage.local. No
// master password - the trust model is "whoever can use this Chrome profile
// owns the data" (same as Chrome's own saved passwords without a sync
// passphrase). The key obfuscates the IndexedDB contents against casual
// inspection; it is NOT protection against someone with full access to the
// OS user account.
//
// PBKDF2 pieces below remain only to unlock and migrate legacy
// password-protected vaults created by older versions.

const PBKDF2_ITERATIONS = 310_000;
const VERIFIER_PLAINTEXT = "fireapply-verifier-v1";
const AUTO_KEY_STORAGE = "autoVaultKeyB64";

export interface CryptoMeta {
  saltB64: string;
  verifierIvB64: string;
  verifierCtB64: string;
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]);
}

let cachedKey: CryptoKey | null = null;

/** The automatic vault key - created on first use, then reused forever. */
export async function getSessionKey(): Promise<CryptoKey | null> {
  if (cachedKey) return cachedKey;
  const stored = await chrome.storage.local.get(AUTO_KEY_STORAGE);
  let raw: Uint8Array;
  if (stored[AUTO_KEY_STORAGE]) {
    raw = unb64(stored[AUTO_KEY_STORAGE]);
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    await chrome.storage.local.set({ [AUTO_KEY_STORAGE]: b64(raw) });
  }
  cachedKey = await crypto.subtle.importKey(
    "raw", raw as BufferSource, { name: "AES-GCM" }, true,
    ["encrypt", "decrypt"]);
  return cachedKey;
}

/** Always true now - kept so callers don't need to change shape. */
export async function isUnlocked(): Promise<boolean> {
  return true;
}

/**
 * Unlock a legacy password-protected vault (pre-0.5 versions) so its data
 * can be migrated to the automatic key. Returns the old key or null when
 * the password is wrong.
 */
export async function unlockLegacyVault(password: string, meta: CryptoMeta): Promise<CryptoKey | null> {
  const key = await deriveKey(password, unb64(meta.saltB64));
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(meta.verifierIvB64) as BufferSource }, key,
      unb64(meta.verifierCtB64) as BufferSource);
    if (new TextDecoder().decode(pt) !== VERIFIER_PLAINTEXT) return null;
  } catch {
    return null;
  }
  return key;
}

export interface EncryptedBox {
  ivB64: string;
  ctB64: string;
}

/** Password-protected box for backup files (salt embedded, portable across machines). */
export interface PasswordBox extends EncryptedBox {
  saltB64: string;
}

export async function encryptJsonWithPassword(value: unknown, password: string): Promise<PasswordBox> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const box = await encryptJson(value, key);
  return { ...box, saltB64: b64(salt) };
}

export async function decryptJsonWithPassword<T>(box: PasswordBox, password: string): Promise<T> {
  const key = await deriveKey(password, unb64(box.saltB64));
  return decryptJson<T>(box, key);
}

export async function encryptJson(value: unknown, key: CryptoKey): Promise<EncryptedBox> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource }, key,
    new TextEncoder().encode(JSON.stringify(value)));
  return { ivB64: b64(iv), ctB64: b64(ct) };
}

export async function decryptJson<T>(box: EncryptedBox, key: CryptoKey): Promise<T> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(box.ivB64) as BufferSource }, key,
    unb64(box.ctB64) as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

export async function encryptBytes(data: ArrayBuffer, key: CryptoKey): Promise<EncryptedBox> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data);
  return { ivB64: b64(iv), ctB64: b64(ct) };
}

export async function decryptBytes(box: EncryptedBox, key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(box.ivB64) as BufferSource }, key,
    unb64(box.ctB64) as BufferSource);
}

export { b64, unb64 };
