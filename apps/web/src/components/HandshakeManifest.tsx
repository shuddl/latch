// The signed co-certification manifest (docs/05 Phase 5, docs/09) — the artifact that
// replaces the human cert round-trip. It renders exactly what the handshake produced: the two
// parties, the six HSP phases completed, the co-certification result hash, and BOTH Ed25519
// signatures. When both sides reach ACTIVE this is provable correctness *between organizations*
// — the network moat made visible. Pure presentational component over a HandshakeOutcome.

import type { HandshakeOutcome } from '../types';
import './handshake.css';

const PHASES = ['HELLO', 'Spec exchange', 'Map negotiation', 'Co-certification', 'Attestation', 'Activate'];

function short(s: string | undefined, head = 10, tail = 6): string {
  if (!s) return '—';
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function HandshakeManifest({ outcome }: { outcome: HandshakeOutcome }) {
  const ok = outcome.ok;
  const signed = outcome.signedManifest;
  const m = signed?.manifest;
  const initiator = m?.parties.initiator;
  const responder = m?.parties.responder;
  // How far the protocol got — on success all six phases are done; on failure, none are claimed.
  const phasesDone = ok ? PHASES.length : 0;

  return (
    <section className={`hs ${ok ? 'is-ok' : 'is-failed'}`} aria-label="Co-certification manifest">
      <header className="hs-verdict">
        <div className="hs-badge" aria-hidden>
          {ok ? '⛓' : '!'}
        </div>
        <div>
          <h1 className="hs-title">{ok ? 'Connected via Latch' : 'Handshake did not certify'}</h1>
          <p className="muted hs-sub">
            {ok
              ? 'Both partners co-certified the connection and counter-signed the proof — no human round-trip.'
              : outcome.error ?? 'The two sides could not agree a provably-correct connection.'}
          </p>
        </div>
      </header>

      {/* The two parties shaking hands. */}
      <div className="hs-parties">
        <PartyCard role="Initiator" org={initiator?.latchOrg ?? '—'} keyId={initiator?.keyId} status={outcome.initiatorStatus} />
        <div className="hs-link" aria-hidden>
          <span className="hs-link-line" />
          <span className="hs-link-glyph">{ok ? '✓' : '✕'}</span>
          <span className="hs-link-line" />
        </div>
        <PartyCard role="Responder" org={responder?.latchOrg ?? '—'} keyId={responder?.keyId} status={outcome.responderStatus} />
      </div>

      {/* Six-phase progress. */}
      <ol className="hs-phases" aria-label="Handshake phases">
        {PHASES.map((p, i) => {
          const done = i < phasesDone;
          const failedHere = !ok && i === phasesDone;
          return (
            <li key={p} className="hs-phase" data-state={done ? 'done' : failedHere ? 'failed' : 'pending'}>
              <span className="hs-phase-dot" aria-hidden>
                {done ? '✓' : failedHere ? '✕' : i + 1}
              </span>
              <span className="hs-phase-label">{p}</span>
            </li>
          );
        })}
      </ol>

      {/* The manifest + signatures (only meaningful on success). */}
      {ok && m && (
        <div className="card hs-manifest">
          <div className="hs-manifest-head">
            <h2 className="panel-title">Certification manifest</h2>
            <span className="hs-chip">HSP {m.hspVersion}</span>
          </div>

          <dl className="hs-fields">
            <Field label="Session" value={short(m.sessionId, 14, 6)} mono />
            <Field label="Canonical model" value={`v${m.canonicalVersion}`} />
            <Field label="Initiator sends" value={m.flows.initiatorSends.join(', ') || '—'} />
            <Field label="Responder sends" value={m.flows.responderSends.join(', ') || '—'} />
            <Field label="Initiator map" value={short(m.mapDigests.initiator)} mono />
            <Field label="Responder map" value={short(m.mapDigests.responder)} mono />
          </dl>

          <div className="hs-cocert">
            <span className="hs-cocert-label">Co-certification result hash</span>
            <code className="hs-cocert-hash">{m.coCertResultHash}</code>
            <p className="muted hs-cocert-note">
              Each side independently reproduced the other’s intended canonical for every golden case — this hash binds
              both results.
            </p>
          </div>

          <div className="hs-sigs">
            <Signature label="Initiator signature" who={initiator?.keyId} sig={signed?.initiatorSig} />
            <Signature label="Responder signature" who={responder?.keyId} sig={signed?.responderSig} />
          </div>
        </div>
      )}
    </section>
  );
}

function PartyCard({ role, org, keyId, status }: { role: string; org: string; keyId?: string | undefined; status: string }) {
  const live = status === 'ACTIVE';
  return (
    <div className="card hs-party" data-live={live}>
      <span className="hs-party-role">{role}</span>
      <strong className="hs-party-org">{org}</strong>
      <span className="mono muted hs-party-key">{keyId ?? '—'}</span>
      <span className="hs-party-status" data-live={live}>
        <span className="health-dot" data-live={live} /> {status}
      </span>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="hs-field">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : ''}>{value}</dd>
    </div>
  );
}

function Signature({ label, who, sig }: { label: string; who?: string | undefined; sig?: string | undefined }) {
  const present = Boolean(sig);
  return (
    <div className="hs-sig" data-present={present}>
      <div className="hs-sig-head">
        <span className="hs-sig-check" aria-hidden>
          {present ? '✓' : '–'}
        </span>
        <span className="hs-sig-label">{label}</span>
        <span className="mono muted hs-sig-who">{who ?? ''}</span>
      </div>
      <code className="hs-sig-value">{sig ? short(sig, 18, 12) : 'unsigned'}</code>
    </div>
  );
}
