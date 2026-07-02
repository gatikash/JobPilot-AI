// Master-password encryption. PBKDF2-SHA256 -> AES-256-GCM.
// The derived key lives only in chrome.storage.session (memory-backed,
// cleared when the browser closes) so every extension context can use it
// while the vault is unlocked, and nothing sensitive is ever written to disk
// unencrypted.

const PBKDF2_ITERATIONS = 310_000;
const VERIFIER_PLAINTEXT = "fireapply-verifier-v1";

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

export async function createVault(password: string): Promise<CryptoMeta> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource }, key,
    new TextEncoder().encode(VERIFIER_PLAINTEXT));
  await storeSessionKey(key);
  return { saltB64: b64(salt), verifierIvB64: b64(iv), verifierCtB64: b64(ct) };
}

/** Returns true and caches the key in session storage when password is correct. */
export async function unlockVault(password: string, meta: CryptoMeta): Promise<boolean> {
  const key = await deriveKey(password, unb64(meta.saltB64));
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(meta.verifierIvB64) as BufferSource }, key,
      unb64(meta.verifierCtB64) as BufferSource);
    if (new TextDecoder().decode(pt) !== VERIFIER_PLAINTEXT) return false;
  } catch {
    return false;
  }
  await storeSessionKey(key);
  return true;
}

export async function lockVault(): Promise<void> {
  await chrome.storage.session.remove("vaultKey");
}

async function storeSessionKey(key: CryptoKey): Promise<void> {
  const raw = await crypto.subtle.exportKey("raw", key);
  await chrome.storage.session.set({ vaultKey: b64(raw) });
}

export async function getSessionKey(): Promise<CryptoKey | null> {
  const { vaultKey } = await chrome.storage.session.get("vaultKey");
  if (!vaultKey) return null;
  return crypto.subtle.importKey(
    "raw", unb64(vaultKey) as BufferSource, { name: "AES-GCM" }, true,
    ["encrypt", "decrypt"]);
}

export async function isUnlocked(): Promise<boolean> {
  return (await getSessionKey()) !== null;
}

export interface EncryptedBox {
  ivB64: string;
  ctB64: string;
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
