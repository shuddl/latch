// A transport-agnostic pump that drives two `HspParticipant`s to completion by shuttling the
// signed envelopes each emits to the other, FIFO, until both quiesce (ACTIVE) or one fails
// (FAILED). This is the reference loop a `HandshakeDO` runs over real HTTPS (deliver an
// envelope to the peer DO, feed its replies back) — here both participants are in-process so
// the over-the-wire protocol is provable without live peers, exactly like `runHandshake`.

import type { HspParticipant } from './participant';
import type { HspEnvelope, SignedManifest } from './types';

export interface DriveOutcome {
  ok: boolean;
  initiatorStatus: string;
  responderStatus: string;
  signedManifest: SignedManifest | null;
  /** Every envelope delivered, in order — the auditable transcript. */
  transcript: HspEnvelope[];
  error?: string;
}

/** Drive a full handshake between two participants over an in-process "wire". */
export async function driveHandshake(
  initiator: HspParticipant,
  responder: HspParticipant,
  sessionId: string,
): Promise<DriveOutcome> {
  const transcript: HspEnvelope[] = [];
  const queue: { to: HspParticipant; env: HspEnvelope }[] = [];
  const peerOf = (p: HspParticipant): HspParticipant => (p === initiator ? responder : initiator);

  for (const env of await initiator.start(sessionId)) queue.push({ to: responder, env });

  // Bounded to guard against a protocol bug looping forever; a real handshake is well under this.
  for (let steps = 0; steps < 1000 && queue.length > 0; steps++) {
    const { to, env } = queue.shift()!;
    transcript.push(env);
    const replies = await to.receive(env);
    const peer = peerOf(to);
    for (const r of replies) queue.push({ to: peer, env: r });
  }

  const ok = initiator.status === 'ACTIVE' && responder.status === 'ACTIVE';
  return {
    ok,
    initiatorStatus: initiator.status,
    responderStatus: responder.status,
    signedManifest: initiator.signedManifest,
    transcript,
    ...(ok ? {} : { error: initiator.error ?? responder.error ?? 'handshake did not reach ACTIVE' }),
  };
}
