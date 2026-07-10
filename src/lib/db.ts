// IndexedDB persistence. Every record is stored as an AES-GCM EncryptedBox;
// only crypto metadata and non-sensitive bookkeeping are plaintext.
// IndexedDB here is the extension origin's database, shared by the service
// worker and all extension pages (popup, side panel, options). Content
// scripts never touch it directly - they go through the background worker.

import {
  EncryptedBox, encryptJson, decryptJson, encryptBytes, decryptBytes,
  getSessionKey, CryptoMeta,
} from "./crypto";
import {
  UserProfile, CountryProfile, ResumeMeta, SavedAnswer, ApplicationRecord,
  AiConfig, defaultAiConfig, normalizeAiConfig, emptyProfile,
} from "./types";

const DB_NAME = "fireapply";
const DB_VERSION = 2;

// object stores
const S_KV = "kv";               // plaintext: cryptoMeta, settings
const S_PROFILE = "profile";     // encrypted single record id="me"
const S_COUNTRY = "countryProfiles"; // encrypted, key countryCode
const S_RESUME_META = "resumeMeta";  // encrypted, key id
const S_FILES = "files";         // encrypted bytes, key resume id
const S_ANSWERS = "savedAnswers";    // encrypted, key id
const S_APPS = "applications";       // encrypted, key id
const S_SECURE = "secure";           // encrypted misc (AI config with API key)

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [S_KV, S_PROFILE, S_COUNTRY, S_RESUME_META, S_FILES, S_ANSWERS, S_APPS, S_SECURE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function rawGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const req = tx.objectStore(store).get(key);
  await txDone(tx);
  return req.result as T | undefined;
}

async function rawPut(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await txDone(tx);
}

async function rawDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

async function rawEntries<T>(store: string): Promise<Map<string, T>> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const os = tx.objectStore(store);
  const keysReq = os.getAllKeys();
  const valsReq = os.getAll();
  await txDone(tx);
  const map = new Map<string, T>();
  keysReq.result.forEach((k, i) => map.set(String(k), valsReq.result[i] as T));
  return map;
}

async function requireKey(): Promise<CryptoKey> {
  const key = await getSessionKey();
  if (!key) throw new Error("LOCKED");
  return key;
}

// ---- crypto meta / settings (plaintext kv) ----

export async function getCryptoMeta(): Promise<CryptoMeta | undefined> {
  return rawGet<CryptoMeta>(S_KV, "cryptoMeta");
}

export async function setCryptoMeta(meta: CryptoMeta): Promise<void> {
  await rawPut(S_KV, "cryptoMeta", meta);
}

export async function deleteCryptoMeta(): Promise<void> {
  await rawDelete(S_KV, "cryptoMeta");
}

/**
 * One-time migration from a legacy password-protected vault: re-encrypt every
 * record under the automatic key, then drop the legacy crypto metadata.
 */
export async function migrateFromLegacyVault(oldKey: CryptoKey): Promise<void> {
  const newKey = await requireKey();
  for (const store of [S_PROFILE, S_COUNTRY, S_RESUME_META, S_ANSWERS, S_APPS, S_SECURE]) {
    const entries = await rawEntries<EncryptedBox>(store);
    for (const [id, box] of entries) {
      const value = await decryptJson<unknown>(box, oldKey);
      await rawPut(store, id, await encryptJson(value, newKey));
    }
  }
  const files = await rawEntries<EncryptedBox>(S_FILES);
  for (const [id, box] of files) {
    const bytes = await decryptBytes(box, oldKey);
    await rawPut(S_FILES, id, await encryptBytes(bytes, newKey));
  }
  await deleteCryptoMeta();
}

export interface Settings {
  autoLockMinutes: number;
}

export async function getSettings(): Promise<Settings> {
  return (await rawGet<Settings>(S_KV, "settings")) ?? { autoLockMinutes: 30 };
}

export async function setSettings(s: Settings): Promise<void> {
  await rawPut(S_KV, "settings", s);
}

// ---- generic encrypted helpers ----

async function getEnc<T>(store: string, key: string): Promise<T | undefined> {
  const box = await rawGet<EncryptedBox>(store, key);
  if (!box) return undefined;
  return decryptJson<T>(box, await requireKey());
}

async function putEnc(store: string, key: string, value: unknown): Promise<void> {
  await rawPut(store, key, await encryptJson(value, await requireKey()));
}

async function allEnc<T>(store: string): Promise<T[]> {
  const key = await requireKey();
  const entries = await rawEntries<EncryptedBox>(store);
  const out: T[] = [];
  for (const box of entries.values()) out.push(await decryptJson<T>(box, key));
  return out;
}

// ---- profile ----

export async function getProfile(): Promise<UserProfile> {
  const p = (await getEnc<UserProfile>(S_PROFILE, "me")) ?? emptyProfile();
  if (!Array.isArray(p.workExperience)) p.workExperience = [];
  return p;
}

export async function saveProfile(p: UserProfile): Promise<void> {
  p.updatedAt = Date.now();
  await putEnc(S_PROFILE, "me", p);
}

// ---- country profiles ----

export async function getCountryProfile(code: string): Promise<CountryProfile | undefined> {
  return getEnc<CountryProfile>(S_COUNTRY, code);
}

export async function saveCountryProfile(cp: CountryProfile): Promise<void> {
  cp.updatedAt = Date.now();
  await putEnc(S_COUNTRY, cp.countryCode, cp);
}

export async function listCountryProfiles(): Promise<CountryProfile[]> {
  return allEnc<CountryProfile>(S_COUNTRY);
}

// ---- resumes ----

export async function listResumes(): Promise<ResumeMeta[]> {
  return allEnc<ResumeMeta>(S_RESUME_META);
}

export async function saveResume(meta: ResumeMeta, data: ArrayBuffer): Promise<void> {
  const key = await requireKey();
  meta.updatedAt = Date.now();
  await rawPut(S_RESUME_META, meta.id, await encryptJson(meta, key));
  await rawPut(S_FILES, meta.id, await encryptBytes(data, key));
}

export async function updateResumeMeta(meta: ResumeMeta): Promise<void> {
  meta.updatedAt = Date.now();
  await putEnc(S_RESUME_META, meta.id, meta);
}

export async function getResumeMeta(id: string): Promise<ResumeMeta | undefined> {
  return getEnc<ResumeMeta>(S_RESUME_META, id);
}

export async function getResumeData(id: string): Promise<ArrayBuffer | undefined> {
  const box = await rawGet<EncryptedBox>(S_FILES, id);
  if (!box) return undefined;
  return decryptBytes(box, await requireKey());
}

export async function deleteResume(id: string): Promise<void> {
  await rawDelete(S_RESUME_META, id);
  await rawDelete(S_FILES, id);
}

// ---- saved answers ----

export async function listSavedAnswers(): Promise<SavedAnswer[]> {
  return allEnc<SavedAnswer>(S_ANSWERS);
}

export async function saveAnswer(a: SavedAnswer): Promise<void> {
  a.updatedAt = Date.now();
  await putEnc(S_ANSWERS, a.id, a);
}

export async function deleteAnswer(id: string): Promise<void> {
  await rawDelete(S_ANSWERS, id);
}

// ---- applications ----

export async function listApplications(): Promise<ApplicationRecord[]> {
  const apps = await allEnc<ApplicationRecord>(S_APPS);
  return apps.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getApplication(id: string): Promise<ApplicationRecord | undefined> {
  return getEnc<ApplicationRecord>(S_APPS, id);
}

export async function saveApplication(rec: ApplicationRecord): Promise<void> {
  rec.updatedAt = Date.now();
  await putEnc(S_APPS, rec.id, rec);
}

export async function deleteApplication(id: string): Promise<void> {
  await rawDelete(S_APPS, id);
}

// ---- AI config (encrypted: contains the API key) ----

export async function getAiConfig(): Promise<AiConfig> {
  return normalizeAiConfig((await getEnc<AiConfig>(S_SECURE, "aiConfig")) ?? defaultAiConfig());
}

export async function saveAiConfig(cfg: AiConfig): Promise<void> {
  cfg.updatedAt = Date.now();
  await putEnc(S_SECURE, "aiConfig", cfg);
}

// ---- backup ----

export interface BackupPayload {
  version: 1;
  exportedAt: number;
  profile: UserProfile;
  countryProfiles: CountryProfile[];
  resumes: { meta: ResumeMeta; dataB64: string }[];
  savedAnswers: SavedAnswer[];
  applications: ApplicationRecord[];
}

export async function buildBackup(): Promise<BackupPayload> {
  const resumes: BackupPayload["resumes"] = [];
  for (const meta of await listResumes()) {
    const data = await getResumeData(meta.id);
    if (!data) continue;
    const bytes = new Uint8Array(data);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    resumes.push({ meta, dataB64: btoa(bin) });
  }
  return {
    version: 1,
    exportedAt: Date.now(),
    profile: await getProfile(),
    countryProfiles: await listCountryProfiles(),
    resumes,
    savedAnswers: await listSavedAnswers(),
    applications: await listApplications(),
  };
}

export async function restoreBackup(payload: BackupPayload): Promise<void> {
  await saveProfile(payload.profile);
  for (const cp of payload.countryProfiles) await saveCountryProfile(cp);
  for (const r of payload.resumes) {
    const bin = atob(r.dataB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await saveResume(r.meta, bytes.buffer);
  }
  for (const a of payload.savedAnswers) await saveAnswer(a);
  for (const app of payload.applications) await saveApplication(app);
}
