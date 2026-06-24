// The Latch control plane (docs/09). Hero flow is three steps and protected:
// add a partner → drop samples → watch it certify → click go-live. No settings,
// no fourth step.

import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { CertificationReportData, Connection } from './types';
import { SAMPLE_214 } from './samples';
import { CertProgress } from './components/CertProgress';
import { CertificationReport } from './components/CertificationReport';
import './App.css';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type View = 'dashboard' | 'onboard';
type Phase = 'partner' | 'drop' | 'certifying' | 'report';

export function App() {
  const [view, setView] = useState<View>('dashboard');
  return (
    <>
      <header className="topbar">
        <span className="wordmark">
          Latch<span className="dot">.</span>
        </span>
        <span className="spacer" />
        <span className="tag-pill">Certified EDI connections</span>
      </header>
      {view === 'dashboard' ? (
        <Dashboard onNew={() => setView('onboard')} />
      ) : (
        <Onboard onDone={() => setView('dashboard')} />
      )}
    </>
  );
}

function Dashboard({ onNew }: { onNew: () => void }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listConnections()
      .then((c) => alive && setConnections(c))
      .catch(() => alive && setConnections([]));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <p className="muted">Stand up a trading-partner connection and prove it’s right — same day.</p>
        </div>
        <button className="btn btn-primary" onClick={onNew}>
          Add connection
        </button>
      </div>

      {connections === null ? (
        <p className="muted">Loading…</p>
      ) : connections.length === 0 ? (
        <div className="empty">
          <p>Add your first partner — drop a guide and we’ll certify the connection today.</p>
          <button className="btn btn-primary" onClick={onNew}>
            Add connection
          </button>
        </div>
      ) : (
        <div className="conn-grid">
          {connections.map((c) => (
            <div key={c.id} className="card conn-card">
              <div className="row">
                <span className="health-dot" data-live={c.status === 'production'} />
                <strong>{c.transactionSet}</strong>
                <span className="muted">· {c.direction}</span>
              </div>
              <span className="status-chip">{c.status}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function Onboard({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('partner');
  const [name, setName] = useState('');
  const [edi, setEdi] = useState('');
  const [step, setStep] = useState(0);
  const [report, setReport] = useState<CertificationReportData | null>(null);
  const [connId, setConnId] = useState<string | null>(null);
  const [goLive, setGoLive] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function buildAndCertify() {
    setError(null);
    setPhase('certifying');
    setStep(0);
    try {
      await sleep(300);
      setStep(1);
      const partner = await api.createPartner(name.trim() || 'New partner');
      await sleep(180);
      const conn = await api.createConnection({
        partnerId: partner.id,
        direction: 'inbound',
        transactionSet: '214',
        connectivity: { type: 'sftp', secretRef: 'demo' },
      });
      setConnId(conn.id);
      await api.addSamples(conn.id, [edi.trim()]);
      setStep(3);
      const map = await api.registerMap(conn.id);
      await sleep(180);
      setStep(4);
      const cert = await api.certify(map.id);
      setStep(6);
      const data = await api.getReport(cert.id);
      setStep(7);
      setReport(data);
      setPhase('report');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Check the API is running.');
      setPhase('drop');
    }
  }

  async function handleGoLive() {
    if (!connId) return;
    setGoLive('busy');
    try {
      await api.goLive(connId);
      setGoLive('done');
    } catch {
      setGoLive('idle');
      setError('Could not go live.');
    }
  }

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>
            {phase === 'report' ? 'Certification' : phase === 'certifying' ? 'Certifying' : 'New connection'}
          </h1>
          {phase !== 'report' && (
            <p className="muted">Three steps: add a partner, drop samples, watch it certify.</p>
          )}
        </div>
        <button className="linklike" onClick={onDone}>
          ← Connections
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {phase === 'partner' && (
        <div className="wizard">
          <div className="field">
            <label htmlFor="pname">Partner name</label>
            <input
              id="pname"
              className="input"
              placeholder="e.g. R&L Carriers"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="wizard-actions">
            <button className="btn btn-primary" onClick={() => setPhase('drop')}>
              Add files
            </button>
          </div>
        </div>
      )}

      {phase === 'drop' && (
        <div className="wizard">
          <div className="dropzone">
            <div className="field">
              <label htmlFor="edi">Drop the companion guide + sample EDI</label>
              <textarea
                id="edi"
                className="textarea"
                placeholder="Paste a sample EDI file…"
                value={edi}
                onChange={(e) => setEdi(e.target.value)}
              />
            </div>
            <button className="linklike" onClick={() => setEdi(SAMPLE_214)} type="button">
              Use a sample 214
            </button>
          </div>
          {edi.trim() && (
            <div className="detected">
              <span aria-hidden>✓</span> Found a <strong>214 Shipment Status</strong> sample, X12 004010. Ready to
              build &amp; certify.
            </div>
          )}
          <div className="wizard-actions">
            <button className="btn btn-primary" onClick={buildAndCertify} disabled={!edi.trim()}>
              Build &amp; certify
            </button>
          </div>
        </div>
      )}

      {phase === 'certifying' && (
        <div className="wizard">
          <span className="steps-label">Proving the map</span>
          <CertProgress active={step} />
        </div>
      )}

      {phase === 'report' && report && (
        <CertificationReport data={report} onGoLive={handleGoLive} goLiveState={goLive} />
      )}
    </main>
  );
}
