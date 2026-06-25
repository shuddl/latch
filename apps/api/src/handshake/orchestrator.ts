// The bilateral orchestrator: drives two handshake PEERS (each a `HandshakeHost`, local or a
// remote `HandshakeDO` reached over HTTPS) through the full HSP to a co-signed manifest. It is
// the over-the-wire analogue of @latch/handshake's in-process `driveHandshake`: configure both
// sides, have the initiator emit HELLO, then shuttle every emitted envelope to the peer and
// feed the peer's replies back, FIFO, until both sides reach ACTIVE (or one FAILS). The pump
// is identical whether the peers are in-memory (tests) or two Durable Objects (production) —
// only the transport behind `HandshakePeer` differs.

import type { HspEnvelope, SignedManifest } from '@latch/handshake';
import type { HostSeed, HostState } from './host';

/** What the orchestrator needs of each side, regardless of transport (local host or DO fetch). */
export interface HandshakePeer {
  configure(seed: HostSeed): Promise<void>;
  start(sessionId: string): Promise<HspEnvelope[]>;
  receive(env: HspEnvelope): Promise<HspEnvelope[]>;
  state(): Promise<HostState>;
}

export interface BilateralOutcome {
  ok: boolean;
  sessionId: string;
  initiatorStatus: string;
  responderStatus: string;
  signedManifest: SignedManifest | null;
  transcript: HspEnvelope[];
  error?: string;
}

export async function orchestrateBilateral(
  initiator: HandshakePeer,
  responder: HandshakePeer,
  initiatorSeed: HostSeed,
  responderSeed: HostSeed,
  sessionId: string,
): Promise<BilateralOutcome> {
  await initiator.configure(initiatorSeed);
  await responder.configure(responderSeed);

  const transcript: HspEnvelope[] = [];
  const queue: { to: HandshakePeer; env: HspEnvelope }[] = [];
  const peerOf = (p: HandshakePeer): HandshakePeer => (p === initiator ? responder : initiator);

  for (const env of await initiator.start(sessionId)) queue.push({ to: responder, env });

  for (let steps = 0; steps < 1000 && queue.length > 0; steps++) {
    const { to, env } = queue.shift()!;
    transcript.push(env);
    const replies = await to.receive(env);
    const peer = peerOf(to);
    for (const r of replies) queue.push({ to: peer, env: r });
  }

  const initState = await initiator.state();
  const respState = await responder.state();
  const ok = initState.status === 'ACTIVE' && respState.status === 'ACTIVE';
  return {
    ok,
    sessionId,
    initiatorStatus: initState.status,
    responderStatus: respState.status,
    signedManifest: initState.signedManifest,
    transcript,
    ...(ok ? {} : { error: initState.error ?? respState.error ?? 'handshake did not reach ACTIVE' }),
  };
}
