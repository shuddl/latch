// The Latch control plane (docs/09). Hero flow is three steps and protected:
// add a partner → drop samples → watch it certify → click go-live. No settings,
// no fourth step.

import { useEffect, useState } from 'react';
import { api, ApiError, type HandshakePartyInput } from './api';
import type { CertificationReportData, Connection, HandshakeOutcome } from './types';
import { SAMPLE_214 } from './samples';
import { CertProgress } from './components/CertProgress';
import { CertificationReport } from './components/CertificationReport';
import { ConnectionDetail } from './components/ConnectionDetail';
import { HandshakeManifest } from './components/HandshakeManifest';
import './App.css';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type View = 'dashboard' | 'onboard' | 'connect';
type Phase = 'partner' | 'drop' | 'certifying' | 'report';

export function App() {
  const [view, setView] = useState<View>('dashboard');
  const [detailId, setDetailId] = useState<string | null>(null);

  return (
    <>
      <header className="topbar">
        <button className="wordmark linklike-plain" onClick={() => { setDetailId(null); setView('dashboard'); }}>
          Latch<span className="dot">.</span>
        </button>
        <span className="spacer" />
        <span className="tag-pill">Certified EDI connections</span>
      </header>
      {detailId ? (
        <ConnectionDetail connectionId={detailId} onBack={() => setDetailId(null)} />
      ) : view === 'dashboard' ? (
        <Dashboard onNew={() => setView('onboard')} onOpen={setDetailId} onConnect={() => setView('connect')} />
      ) : view === 'connect' ? (
        <ConnectView onDone={() => setView('dashboard')} />
      ) : (
        <Onboard onDone={() => setView('dashboard')} />
      )}
    </>
  );
}

function Dashboard({
  onNew,
  onOpen,
  onConnect,
}: {
  onNew: () => void;
  onOpen: (id: string) => void;
  onConnect: () => void;
}) {
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
        <div className="head-actions">
          <button className="btn" onClick={onConnect}>
            Connect via Latch
          </button>
          <button className="btn btn-primary" onClick={onNew}>
            Add connection
          </button>
        </div>
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
            <button key={c.id} className="card conn-card" onClick={() => onOpen(c.id)}>
              <div className="row">
                <span className="health-dot" data-live={c.status === 'production'} />
                <strong>{c.transactionSet}</strong>
                <span className="muted">· {c.direction}</span>
              </div>
              <span className="status-chip">{c.status}</span>
            </button>
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

// "Connect via Latch" (docs/05 / M6.3): run a bilateral handshake between two parties' certified
// maps and render the co-signed manifest — provable correctness *between* organizations.
function ConnectView({ onDone }: { onDone: () => void }) {
  const [initiator, setInitiator] = useState({ org: 'acme', mapId: '', set: '214' });
  const [responder, setResponder] = useState({ org: 'beta', mapId: '', set: '214' });
  const [sample, setSample] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<HandshakeOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = initiator.mapId.trim() && responder.mapId.trim() && sample.trim();

  async function run() {
    setError(null);
    setBusy(true);
    setOutcome(null);
    try {
      const cases = [{ name: 'sample-1', input: sample.trim() }];
      const mkParty = (p: typeof initiator): HandshakePartyInput => ({
        org: p.org.trim(),
        mapId: p.mapId.trim(),
        set: p.set.trim(),
        cases,
      });
      const res = await api.runHandshake({ initiator: mkParty(initiator), responder: mkParty(responder) });
      setOutcome(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Handshake could not run. Check the API is deployed with DO bindings.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>{outcome ? 'Co-certification' : 'Connect via Latch'}</h1>
          {!outcome && (
            <p className="muted">
              Two partners negotiate and co-certify a connection — ending in a signed manifest, no human round-trip.
            </p>
          )}
        </div>
        <button className="linklike" onClick={onDone}>
          ← Connections
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!outcome ? (
        <div className="wizard">
          <div className="connect-parties">
            <PartyForm title="Initiator" value={initiator} onChange={setInitiator} />
            <PartyForm title="Responder" value={responder} onChange={setResponder} />
          </div>
          <div className="field">
            <label htmlFor="hs-sample">Golden sample to co-certify</label>
            <textarea
              id="hs-sample"
              className="textarea"
              placeholder="Paste a sample EDI file both sides will co-certify…"
              value={sample}
              onChange={(e) => setSample(e.target.value)}
            />
            <button className="linklike" type="button" onClick={() => setSample(SAMPLE_214)}>
              Use a sample 214
            </button>
          </div>
          <div className="wizard-actions">
            <button className="btn btn-primary" onClick={run} disabled={!ready || busy}>
              {busy ? 'Handshaking…' : 'Run handshake'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <HandshakeManifest outcome={outcome} initiatorOrg={initiator.org} responderOrg={responder.org} />
          <div className="wizard-actions">
            <button className="btn" onClick={() => setOutcome(null)}>
              Run another
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function PartyForm({
  title,
  value,
  onChange,
}: {
  title: string;
  value: { org: string; mapId: string; set: string };
  onChange: (v: { org: string; mapId: string; set: string }) => void;
}) {
  // PartyForm renders twice on the page, so ids must be unique per party for label/input
  // association (WCAG AA — the design language requires it).
  const p = title.toLowerCase();
  return (
    <div className="card connect-party">
      <span className="connect-party-title">{title}</span>
      <div className="field">
        <label htmlFor={`${p}-org`}>Org</label>
        <input
          id={`${p}-org`}
          className="input"
          value={value.org}
          onChange={(e) => onChange({ ...value, org: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={`${p}-mapId`}>Map ID</label>
        <input
          id={`${p}-mapId`}
          className="input"
          placeholder="map_…"
          value={value.mapId}
          onChange={(e) => onChange({ ...value, mapId: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={`${p}-set`}>Transaction set</label>
        <input
          id={`${p}-set`}
          className="input"
          value={value.set}
          onChange={(e) => onChange({ ...value, set: e.target.value })}
        />
      </div>
    </div>
  );
}
