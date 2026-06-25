// HSP cryptography (docs/05 §security): Ed25519 over canonicalized envelopes + manifests,
// using WebCrypto (available on Workers and Node 20+). Keys are per-session-pinned; the
// signature covers the deterministically-serialized payload so both sides hash identically.
//
// The WebCrypto surface is accessed through a minimal local interface rather than the ambient
// DOM `SubtleCrypto`/`CryptoKey` types — so this module compiles under ANY consuming
// package's tsconfig lib (the monorepo type-checks these sources from each importer).

import { stableStringify } from '@latch/shared';
import type { CertManifest, HspEnvelope } from './types';

/** Opaque handle to a WebCrypto key (a real `CryptoKey` at runtime). */
export type KeyHandle = unknown;

interface SubtleLike {
  generateKey(algo: { name: string }, extractable: boolean, usages: string[]): Promise<{ publicKey: KeyHandle; privateKey: KeyHandle }>;
  exportKey(format: string, key: KeyHandle): Promise<ArrayBuffer>;
  importKey(format: string, data: Uint8Array, algo: { name: string }, extractable: boolean, usages: string[]): Promise<KeyHandle>;
  sign(algo: { name: string }, key: KeyHandle, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algo: { name: string }, key: KeyHandle, sig: Uint8Array, data: Uint8Array): Promise<boolean>;
  digest(algo: string, data: Uint8Array): Promise<ArrayBuffer>;
}

const enc = new TextEncoder();
const subtle = (): SubtleLike => {
  const c = (globalThis as unknown as { crypto?: { subtle?: SubtleLike } }).crypto;
  if (!c?.subtle) {
    throw new Error('WebCrypto (globalThis.crypto.subtle) is unavailable; HSP signing requires a Workers or Node 20+ runtime');
  }
  return c.subtle;
};

function abToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface KeyPair {
  /** Base64 SPKI of the public key — what travels on the wire (HELLO) and pins the session. */
  publicKey: string;
  privateKey: KeyHandle;
}

/** Generate an Ed25519 key pair for a Latch org / session. */
export async function generateKeyPair(): Promise<KeyPair> {
  const kp = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const spki = await subtle().exportKey('spki', kp.publicKey);
  return { publicKey: abToB64(spki), privateKey: kp.privateKey };
}

async function signBytes(privateKey: KeyHandle, data: Uint8Array): Promise<string> {
  return abToB64(await subtle().sign({ name: 'Ed25519' }, privateKey, data));
}
async function verifyBytes(publicKeyB64: string, data: Uint8Array, sigB64: string): Promise<boolean> {
  try {
    const key = await subtle().importKey('spki', b64ToBytes(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, key, b64ToBytes(sigB64), data);
  } catch {
    return false; // malformed key/sig → not verified (never throw into a verify path)
  }
}

/** SHA-256 hex over a deterministically-serialized value (golden result + manifest hashes). */
export async function sha256Hex(value: unknown): Promise<string> {
  const digest = await subtle().digest('SHA-256', enc.encode(stableStringify(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bytes a signature covers: the envelope minus its own `sig`, canonicalized. */
function envelopeBytes(env: HspEnvelope): Uint8Array {
  const { sig: _omit, ...rest } = env;
  void _omit;
  return enc.encode(stableStringify(rest));
}

export async function signEnvelope<P>(env: HspEnvelope<P>, privateKey: KeyHandle): Promise<HspEnvelope<P>> {
  return { ...env, sig: await signBytes(privateKey, envelopeBytes(env)) };
}
export async function verifyEnvelope(env: HspEnvelope, publicKeyB64: string): Promise<boolean> {
  if (!env.sig) return false;
  return verifyBytes(publicKeyB64, envelopeBytes(env), env.sig);
}

export async function signManifest(manifest: CertManifest, privateKey: KeyHandle): Promise<string> {
  return signBytes(privateKey, enc.encode(stableStringify(manifest)));
}
export async function verifyManifestSig(manifest: CertManifest, sigB64: string, publicKeyB64: string): Promise<boolean> {
  return verifyBytes(publicKeyB64, enc.encode(stableStringify(manifest)), sigB64);
}
