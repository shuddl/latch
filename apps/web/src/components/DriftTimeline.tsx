// The self-heal drift timeline (docs/09). Emotional target: relief. Each event is a
// calm, plain-English card — "we caught it, we fixed it, nothing for you to do" —
// with a one-click approval only when policy requires it.

import type { DriftEvent } from '../types';
import './drift.css';

function summarize(ev: DriftEvent): { summary: string; shadowPassed: boolean | undefined } {
  try {
    const d = JSON.parse(ev.detail) as {
      findings?: { detail?: string }[];
      shadowPassed?: boolean;
    };
    return { summary: d.findings?.[0]?.detail ?? ev.kind, shadowPassed: d.shadowPassed };
  } catch {
    return { summary: ev.kind, shadowPassed: undefined };
  }
}

function when(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const TONE: Record<DriftEvent['status'], 'ok' | 'attention' | 'muted'> = {
  auto_applied: 'ok',
  applied: 'ok',
  awaiting_approval: 'attention',
  open: 'attention',
  patched_shadow: 'attention',
  dismissed: 'muted',
};

export function DriftTimeline({
  events,
  onApprove,
  onDismiss,
  busyId,
}: {
  events: DriftEvent[];
  onApprove?: (id: string) => void;
  onDismiss?: (id: string) => void;
  busyId?: string | null;
}) {
  if (events.length === 0) {
    return (
      <div className="drift-empty">
        <span className="health-dot" data-live="true" /> No drift. The connection is steady — we’re watching.
      </div>
    );
  }

  return (
    <ol className="drift-timeline" aria-label="Drift timeline">
      {events.map((ev) => {
        const { summary, shadowPassed } = summarize(ev);
        const tone = TONE[ev.status] ?? 'attention';
        const pending = ev.status === 'awaiting_approval' || ev.status === 'open';
        const busy = busyId === ev.id;
        return (
          <li key={ev.id} className="drift-card" data-tone={tone}>
            <div className="drift-marker" aria-hidden>
              {tone === 'ok' ? '✓' : tone === 'muted' ? '–' : '!'}
            </div>
            <div className="drift-body">
              <div className="drift-head">
                <strong>{TITLES[ev.status] ?? 'Caught a change'}</strong>
                <span className="drift-time mono">{when(ev.createdAt)}</span>
              </div>
              <p className="drift-text">
                {summary}
                {ev.status === 'auto_applied' && (
                  <>
                    {' '}
                    We re-certified (100% ✓) and applied it automatically.{' '}
                    <strong>Nothing for you to do.</strong>
                  </>
                )}
                {ev.status === 'awaiting_approval' && (
                  <> We’ve built and re-certified the fix in shadow{shadowPassed ? ' (100% ✓)' : ''}. Apply it?</>
                )}
                {ev.status === 'open' && <> We’re holding the last-good map so nothing breaks.</>}
              </p>
              {pending && (onApprove || onDismiss) && (
                <div className="drift-actions">
                  {ev.status === 'awaiting_approval' && onApprove && (
                    <button className="btn btn-go" disabled={busy} onClick={() => onApprove(ev.id)}>
                      {busy ? 'Applying…' : 'Apply'}
                    </button>
                  )}
                  {onDismiss && (
                    <button className="btn" disabled={busy} onClick={() => onDismiss(ev.id)}>
                      Dismiss
                    </button>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const TITLES: Record<DriftEvent['status'], string> = {
  auto_applied: 'Caught a change',
  applied: 'Applied your approval',
  awaiting_approval: 'Needs your OK',
  open: 'Caught a change we couldn’t auto-fix',
  patched_shadow: 'Re-certifying',
  dismissed: 'Dismissed',
};
