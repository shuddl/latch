// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { HandshakeManifest } from './HandshakeManifest';
import type { HandshakeOutcome } from '../types';

afterEach(cleanup);

function okOutcome(): HandshakeOutcome {
  return {
    sessionId: 'handshake_abc123def456',
    ok: true,
    initiatorStatus: 'ACTIVE',
    responderStatus: 'ACTIVE',
    signedManifest: {
      manifest: {
        hspVersion: '1.0',
        sessionId: 'handshake_abc123def456',
        canonicalVersion: '1',
        parties: { initiator: { latchOrg: 'acme', keyId: 'acme-key' }, responder: { latchOrg: 'beta', keyId: 'beta-key' } },
        mapDigests: { initiator: 'mapdig_aaaaaaaaaaaaaaaa', responder: 'mapdig_bbbbbbbbbbbbbbbb' },
        coCertResultHash: 'f'.repeat(64),
        flows: { initiatorSends: ['214'], responderSends: ['214'] },
        createdAt: 0,
      },
      initiatorSig: 'AAAA'.repeat(16),
      responderSig: 'BBBB'.repeat(16),
    },
  };
}

describe('HandshakeManifest', () => {
  it('renders the co-signed proof when both sides reach ACTIVE', () => {
    render(<HandshakeManifest outcome={okOutcome()} />);
    expect(screen.getByText('Connected via Latch')).toBeTruthy();
    expect(screen.getByText('acme')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    // The co-cert result hash is shown in full.
    expect(screen.getByText('f'.repeat(64))).toBeTruthy();
    // Both signatures present.
    expect(screen.getByText('Initiator signature')).toBeTruthy();
    expect(screen.getByText('Responder signature')).toBeTruthy();
  });

  it('renders a failure verdict with the error, fallback org names, and no manifest', () => {
    const failed: HandshakeOutcome = {
      sessionId: 's',
      ok: false,
      initiatorStatus: 'FAILED',
      responderStatus: 'FAILED',
      signedManifest: null,
      error: 'co-certification mismatch: peer did not reproduce the intended canonical',
    };
    render(<HandshakeManifest outcome={failed} initiatorOrg="acme" responderOrg="beta" />);
    expect(screen.getByText('Handshake did not certify')).toBeTruthy();
    expect(screen.getByText(/co-certification mismatch/)).toBeTruthy();
    // Even with no manifest, the parties are still named from the form-state fallbacks.
    expect(screen.getByText('acme')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.queryByText('Certification manifest')).toBeNull();
  });
});
