// Connection detail (docs/09 Screen 5 + self-heal). The resting state is boring on
// purpose: health at a glance, the drift timeline (relief), and the transaction stream.

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Certification, Connection, DriftEvent, MapRecord, Transaction } from '../types';
import { DriftTimeline } from './DriftTimeline';
import './detail.css';

type Detail = Connection & { maps: MapRecord[]; activeMap: MapRecord | null; latestCert: Certification | null };

export function ConnectionDetail({ connectionId, onBack }: { connectionId: string; onBack: () => void }) {
  const [conn, setConn] = useState<Detail | null>(null);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [drift, setDrift] = useState<DriftEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDrift = () => api.listDrift(connectionId).then(setDrift).catch(() => undefined);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      api.getConnection(connectionId),
      api.listTransactions(connectionId),
      api.listDrift(connectionId),
    ]).then(([c, t, d]) => {
      if (!alive) return;
      if (c.status === 'fulfilled') setConn(c.value);
      else setError('Could not load this connection.');
      if (t.status === 'fulfilled') setTxns(t.value);
      if (d.status === 'fulfilled') setDrift(d.value);
    });
    return () => {
      alive = false;
    };
  }, [connectionId]);

  async function act(id: string, fn: (id: string) => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn(id);
      await loadDrift();
    } catch {
      setError('That drift event could not be updated.');
    } finally {
      setBusy(null);
    }
  }

  // Until the connection itself loads, show a clean loading/error state rather than
  // flashing zeroed health stats.
  if (!conn) {
    return (
      <main className="container">
        <div className="page-head">
          <h1>Connection</h1>
          <button className="linklike" onClick={onBack}>
            ← Connections
          </button>
        </div>
        {error ? <div className="error-banner">{error}</div> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  const processed = txns.length;
  const acked = txns.filter((t) => t.ackStatus === 'accepted').length;
  const exceptions = txns.filter((t) => t.status === 'error').length;
  const driftCaught = drift.length;

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>{`${conn.transactionSet} · ${conn.direction}`}</h1>
          <p className="muted">
            <span className="health-dot" data-live={conn.status === 'production'} /> {conn.status}
          </p>
        </div>
        <button className="linklike" onClick={onBack}>
          ← Connections
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <section className="health-row">
        <Stat label="Processed" value={processed} />
        <Stat label="997s sent" value={acked} />
        <Stat label="Drift caught" value={driftCaught} tone={driftCaught > 0 ? 'attention' : 'ok'} />
        <Stat label="Exceptions" value={exceptions} tone={exceptions > 0 ? 'failed' : 'ok'} />
      </section>

      <section className="detail-section">
        <h2 className="panel-title">Self-heal</h2>
        <DriftTimeline
          events={drift}
          busyId={busy}
          onApprove={(id) => act(id, api.approveDrift)}
          onDismiss={(id) => act(id, api.dismissDrift)}
        />
      </section>

      <section className="detail-section">
        <h2 className="panel-title">
          Transactions <span className="muted">· newest first</span>
        </h2>
        {txns.length === 0 ? (
          <p className="muted">No traffic yet.</p>
        ) : (
          <ul className="txn-list">
            {txns.map((t) => (
              <li key={t.id} className="txn-row" data-status={t.status}>
                <span className="txn-dot" />
                <span className="mono txn-set">{t.transactionSet}</span>
                <span className="muted mono txn-ctrl">
                  {[t.isaControl, t.gsControl, t.stControl].filter(Boolean).join(' · ')}
                </span>
                <span className="txn-status">{t.status}</span>
                {t.ackStatus && <span className="txn-ack mono">997 {t.ackStatus}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, tone = 'ok' }: { label: string; value: number; tone?: 'ok' | 'attention' | 'failed' }) {
  return (
    <div className="health-stat" data-tone={tone}>
      <div className="health-value">{value}</div>
      <div className="health-label">{label}</div>
    </div>
  );
}
