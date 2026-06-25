// Typed client for the Latch control plane (docs/08). Errors surface the API's
// plain-English message envelope, never a raw status.

import type {
  Certification,
  CertificationReportData,
  Connection,
  DriftEvent,
  HandshakeOutcome,
  MapRecord,
  Partner,
  Transaction,
} from './types';

/** One party in a bilateral handshake request (the product's own input: a map + samples). */
export interface HandshakePartyInput {
  org: string;
  tenantId?: string;
  mapId: string;
  set: string;
  cases: { name: string; input: string }[];
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8787';
const ORG = (import.meta.env.VITE_DEV_ORG as string | undefined) ?? 'default';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Latch-Dev-Org': ORG,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  listConnections: () => call<Connection[]>('/v1/connections'),
  getConnection: (id: string) =>
    call<Connection & { maps: MapRecord[]; activeMap: MapRecord | null; latestCert: Certification | null }>(
      `/v1/connections/${id}`,
    ),

  createPartner: (name: string) => post<Partner>('/v1/partners', { name }),
  createConnection: (input: {
    partnerId: string;
    direction: 'inbound' | 'outbound';
    transactionSet: string;
    connectivity: { type: string; secretRef?: string };
  }) => post<Connection>('/v1/connections', input),

  addSamples: (connectionId: string, samples: string[]) =>
    post<{ sampleCount: number }>(`/v1/connections/${connectionId}/samples`, { samples }),
  registerMap: (connectionId: string) => post<MapRecord>(`/v1/connections/${connectionId}/maps`, {}),
  // A below-bar result comes back as 422 with the cert body — that's a real, renderable
  // outcome (the report shows exactly what fell short), not a transport error.
  certify: async (mapId: string): Promise<Certification> => {
    const res = await fetch(`${BASE}/v1/maps/${mapId}/certify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Latch-Dev-Org': ORG },
      body: '{}',
    });
    const body = JSON.parse((await res.text()) || 'null');
    if (res.status === 200 || res.status === 422) return body as Certification;
    const e = body?.error ?? {};
    throw new ApiError(e.code ?? 'ERROR', e.message ?? `Certify failed (${res.status})`, res.status);
  },
  getReport: (certId: string) => call<CertificationReportData>(`/v1/certifications/${certId}/report`),
  goLive: (connectionId: string) => post<Connection>(`/v1/connections/${connectionId}/go-live`, {}),

  ingest: (connectionId: string, raw: string) =>
    post<{ transaction: Transaction; duplicate: boolean; ackStatus: string }>(
      `/v1/connections/${connectionId}/ingest`,
      { raw },
    ),
  listTransactions: (connectionId: string) =>
    call<Transaction[]>(`/v1/connections/${connectionId}/transactions`),

  listDrift: (connectionId: string) => call<DriftEvent[]>(`/v1/connections/${connectionId}/drift`),
  approveDrift: (id: string) => post<DriftEvent>(`/v1/drift/${id}/approve`, {}),
  dismissDrift: (id: string) => post<DriftEvent>(`/v1/drift/${id}/dismiss`, {}),

  // Handshake (HSP). A below-cert outcome comes back as 422 with the outcome body — a real,
  // renderable result (the proof simply didn't co-certify), not a transport error.
  runHandshake: async (input: {
    initiator: HandshakePartyInput;
    responder: HandshakePartyInput;
    canonicalVersion?: string;
    sessionId?: string;
  }): Promise<HandshakeOutcome> => {
    const res = await fetch(`${BASE}/v1/handshake/bilateral`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Latch-Dev-Org': ORG },
      body: JSON.stringify(input),
    });
    const body = JSON.parse((await res.text()) || 'null');
    if (res.status === 200 || res.status === 422) return body as HandshakeOutcome;
    const e = body?.error ?? {};
    throw new ApiError(e.code ?? 'ERROR', e.message ?? `Handshake failed (${res.status})`, res.status);
  },
  getHandshake: (sessionId: string) => call<HandshakeOutcome>(`/v1/handshake/${sessionId}`),
};
