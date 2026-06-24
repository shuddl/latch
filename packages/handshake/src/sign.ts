// HSP cryptography (docs/05 §security): Ed25519 over canonicalized envelopes + manifests,
// using WebCrypto (available on Workers and Node 20+). Keys are per-session-pinned; the
// signature covers the deterministically-serialized payload so both sides hash identically.

import { stableStringify } from '@latch/shared';
import type { CertManifest, HspEnvelope } from './types';

const enc = new TextEncoder();
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

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
  privateKey: CryptoKey;
}

/** Generate an Ed25519 key pair for a Latch org / session. */
export async function generateKeyPair(): Promise<KeyPair> {
  const kp = (await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = await subtle().exportKey('spki', kp.publicKey);
  return { publicKey: abToB64(spki), privateKey: kp.privateKey };
}

async function signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await subtle().sign({ name: 'Ed25519' }, privateKey, data as BufferSource);
  return abToB64(sig);
}
async function verifyBytes(publicKeyB64: string, data: Uint8Array, sigB64: string): Promise<boolean> {
  try {
    const key = await subtle().importKey('spki', b64ToBytes(publicKeyB64) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, key, b64ToBytes(sigB64) as BufferSource, data as BufferSource);
  } catch {
    return false; // malformed key/sig → not verified (never throw into a verify path)
  }
}

/** SHA-256 hex over a deterministically-serialized value (golden result + manifest hashes). */
export async function sha256Hex(value: unknown): Promise<string> {
  const digest = await subtle().digest('SHA-256', enc.encode(stableStringify(value)) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bytes a signature covers: the envelope minus its own `sig`, canonicalized. */
function envelopeBytes(env: HspEnvelope): Uint8Array {
  const { sig: _omit, ...rest } = env;
  void _omit;
  return enc.encode(stableStringify(rest));
}

export async function signEnvelope<P>(env: HspEnvelope<P>, privateKey: CryptoKey): Promise<HspEnvelope<P>> {
  return { ...env, sig: await signBytes(privateKey, envelopeBytes(env)) };
}
export async function verifyEnvelope(env: HspEnvelope, publicKeyB64: string): Promise<boolean> {
  if (!env.sig) return false;
  return verifyBytes(publicKeyB64, envelopeBytes(env), env.sig);
}

export async function signManifest(manifest: CertManifest, privateKey: CryptoKey): Promise<string> {
  return signBytes(privateKey, enc.encode(stableStringify(manifest)));
}
export async function verifyManifestSig(manifest: CertManifest, sigB64: string, publicKeyB64: string): Promise<boolean> {
  return verifyBytes(publicKeyB64, enc.encode(stableStringify(manifest)), sigB64);
}
