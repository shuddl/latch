// The visual certification report (docs/09 Screen 4) — the artifact you'd proudly
// send a partner. Renders exactly what the Proof produced: a verdict, the headline
// numbers, every benchmark dimension, a corpus heatmap, the adversarial panel, and
// the precise shortfalls when below bar. Pure presentational component.

import { useState } from 'react';
import type { CertificationResult } from '@latch/verify';
import type { CertificationReportData } from '../types';
import { Gauge } from './Gauge';
import './report.css';

type RecordResult = CertificationResult['records'][number];

const DIMENSIONS: { key: string; label: string }[] = [
  { key: 'requiredSegmentCoverage', label: 'Required segments' },
  { key: 'qualifierCoverage', label: 'Qualifiers' },
  { key: 'loopCoverage', label: 'Loops' },
  { key: 'roundTripFidelity', label: 'Round-trip fidelity' },
  { key: 'adversarialGraceful', label: 'Edge cases handled' },
  { key: 'deviationHandling', label: 'Observed deviations' },
];

function pct(v: number): string {
  return `${(v * 100).toFixed(v === 1 ? 0 : 2)}%`;
}

function recordPassed(r: RecordResult): boolean {
  if (r.category === 'adversarial') return r.graceful === true;
  return r.roundTrip && r.forwardMatch !== false && r.differentialMatch !== false;
}

export function CertificationReport({
  data,
  onGoLive,
  goLiveState = 'idle',
}: {
  data: CertificationReportData;
  onGoLive?: () => void;
  goLiveState?: 'idle' | 'busy' | 'done';
}) {
  const { certification: cert, result } = data;
  const passed = cert.passed;
  const [selected, setSelected] = useState<RecordResult | null>(null);

  const headline = [
    { label: 'Coverage', value: cert.requiredCoverage },
    { label: 'Qualifiers', value: cert.qualifierCoverage },
    { label: 'Round-trip', value: cert.roundtripFidelity },
    { label: 'Edge cases', value: cert.adversarialOk },
  ];

  const records = result?.records ?? [];
  const adversarial = records.filter((r) => r.category === 'adversarial');
  const adversarialOk = adversarial.filter((r) => r.graceful === true).length;

  return (
    <section className={`report ${passed ? 'is-passed' : 'is-below'}`} aria-label="Certification report">
      {/* Verdict */}
      <header className="report-verdict">
        <div className="verdict-badge" aria-hidden>
          {passed ? '✓' : '!'}
        </div>
        <div>
          <h1 className="verdict-title">{passed ? 'Certified' : 'Below bar'}</h1>
          <p className="muted verdict-sub">
            {passed
              ? 'Proven by injection against golden records — ready for production.'
              : 'Not yet provable. The exact gaps are listed below; fix and re-certify.'}
          </p>
        </div>
        <div className="verdict-numbers">
          {headline.map((h) => (
            <div key={h.label} className="stat">
              <div className={`stat-value ${h.value >= 1 ? 'ok' : 'warn'}`}>{pct(h.value)}</div>
              <div className="stat-label">{h.label}</div>
            </div>
          ))}
        </div>
      </header>

      <div className="report-grid">
        {/* Dimensions */}
        <div className="card panel">
          <h2 className="panel-title">Benchmark dimensions</h2>
          <ul className="dims">
            {DIMENSIONS.map((d) => {
              const dim = result?.dimensions?.[d.key];
              const v = dim?.value ?? 0;
              const ok = dim ? dim.passed : false;
              return (
                <li key={d.key} className="dim">
                  <span className="dim-icon" data-ok={ok} aria-hidden>
                    {ok ? '✓' : '✕'}
                  </span>
                  <span className="dim-label">{d.label}</span>
                  <span className="dim-bar" aria-hidden>
                    <span className="dim-bar-fill" data-ok={ok} style={{ width: `${Math.max(2, v * 100)}%` }} />
                  </span>
                  <span className="dim-value mono">{pct(v)}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Round-trip gauge */}
        <div className="card panel panel-center">
          <h2 className="panel-title">Round-trip fidelity</h2>
          <Gauge value={cert.roundtripFidelity} threshold={0.999} label="lossless" />
          <p className="muted gauge-note">EDI → canonical → EDI reproduced every populated element.</p>
        </div>
      </div>

      {/* Corpus heatmap */}
      {records.length > 0 && (
        <div className="card panel">
          <h2 className="panel-title">
            Injected corpus <span className="muted">· {records.length} cases</span>
          </h2>
          <div className="heatmap" role="list">
            {records.map((r) => {
              const ok = recordPassed(r);
              return (
                <button
                  key={r.name}
                  role="listitem"
                  className="cell"
                  data-ok={ok}
                  data-selected={selected?.name === r.name}
                  title={`${r.name} — ${r.category}`}
                  aria-label={`${r.name}, ${r.category}, ${ok ? 'passed' : 'failed'}`}
                  onClick={() => setSelected(r)}
                />
              );
            })}
          </div>
          {selected && (
            <div className="cell-detail">
              <div className="cell-detail-head">
                <strong className="mono">{selected.name}</strong>
                <span className="tag">{selected.category}</span>
              </div>
              <div className="cell-flags">
                <Flag label="round-trip" on={selected.roundTrip} />
                <Flag label="forward oracle" on={selected.forwardMatch} />
                <Flag label="differential" on={selected.differentialMatch} />
                {selected.category === 'adversarial' && <Flag label="graceful" on={selected.graceful} />}
                <span className="mono muted">fidelity {pct(selected.fidelity)}</span>
              </div>
              {selected.issues.length > 0 && (
                <ul className="issues">
                  {selected.issues.map((i, idx) => (
                    <li key={idx}>{i}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Adversarial confidence */}
      {adversarial.length > 0 && (
        <div className="adv" data-ok={adversarialOk === adversarial.length}>
          <strong>{adversarial.length}</strong> malformed input{adversarial.length === 1 ? '' : 's'},{' '}
          {adversarialOk === adversarial.length
            ? 'all safely rejected with reasons.'
            : `${adversarial.length - adversarialOk} slipped through.`}
        </div>
      )}

      {/* Shortfalls (below bar) */}
      {!passed && (result?.shortfalls?.length ?? cert.shortfalls.length) > 0 && (
        <div className="card panel shortfalls">
          <h2 className="panel-title">What fell short</h2>
          <ul>
            {(result?.shortfalls ?? cert.shortfalls).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <footer className="report-actions">
        {passed ? (
          <button
            className="btn btn-go"
            onClick={onGoLive}
            disabled={goLiveState !== 'idle'}
          >
            {goLiveState === 'done' ? 'Live ✓' : goLiveState === 'busy' ? 'Going live…' : 'Go live'}
          </button>
        ) : (
          <span className="muted">Resolve the items above, then re-certify.</span>
        )}
        <span className="mono muted report-hash">map {cert.mapHash.slice(0, 14)}</span>
      </footer>
    </section>
  );
}

function Flag({ label, on }: { label: string; on: boolean | undefined }) {
  const state = on === undefined ? 'na' : on ? 'on' : 'off';
  return (
    <span className="flag" data-state={state}>
      <span aria-hidden>{state === 'on' ? '✓' : state === 'off' ? '✕' : '–'}</span> {label}
    </span>
  );
}
