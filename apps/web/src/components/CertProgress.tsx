// The live certification timeline (docs/09 Screen 3 — the signature moment). It makes
// the invisible rigour of certification visible and a little theatrical. Steps flip to
// ✓ as the build progresses; the last one resolves when the Proof returns.

import './progress.css';

export const CERT_STEPS = [
  'Reading the companion guide',
  'Learning from your sample files',
  'Building the map',
  'Generating test cases — valid, boundary, every qualifier, edge & malformed',
  'Injecting tested EDI through the map',
  'Proving round-trip fidelity',
  'Scoring against the benchmark bar',
] as const;

export function CertProgress({ active, failed }: { active: number; failed?: boolean }) {
  return (
    <ol className="cert-progress" aria-label="Certification progress">
      {CERT_STEPS.map((step, i) => {
        const state =
          i < active ? 'done' : i === active ? (failed ? 'failed' : 'active') : 'pending';
        return (
          <li key={step} className="cp-step" data-state={state}>
            <span className="cp-marker" aria-hidden>
              {state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'active' ? '' : ''}
            </span>
            <span className="cp-label">{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
