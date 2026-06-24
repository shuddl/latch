// One behavioural contract, run against every Store implementation (InMemory + D1R2).
// This is what makes the production SQL store trustworthy: identical assertions, real
// migration. Tenants used: 'default' (always seeded) and 'other'.

import { beforeEach, expect, it } from 'vitest';
import { MAP_214_STATUSEVENT, computeCompiledHash } from '@latch/transform';
import type { CertificationResult, DimensionScore } from '@latch/verify';
import type { Store } from './store';

function makeResult(passed: boolean): CertificationResult {
  const dim = (value: number, threshold = 1): DimensionScore => ({
    value,
    threshold,
    passed: value >= threshold,
  });
  return {
    mapHash: 'map_test',
    corpusHash: 'corpus_test',
    passed,
    dimensions: {
      requiredSegmentCoverage: dim(1),
      qualifierCoverage: dim(1),
      loopCoverage: dim(1),
      roundTripFidelity: dim(1, 0.999),
      adversarialGraceful: dim(1),
      deviationHandling: dim(1),
    },
    records: [],
    shortfalls: passed ? [] : ['statusCode mis-mapped'],
  };
}

async function seedMap(store: Store, tenantId: string) {
  const partner = await store.createPartner(tenantId, { name: 'R&L Carriers' });
  const connection = await store.createConnection(tenantId, {
    partnerId: partner.id,
    direction: 'inbound',
    transactionSet: '214',
    x12Version: '004010',
    connectivity: { type: 'sftp', secretRef: 'sftp_main' },
  });
  const map = await store.createMap(tenantId, {
    connectionId: connection.id,
    transactionSet: '214',
    direction: MAP_214_STATUSEVENT.direction,
    canonicalVersion: MAP_214_STATUSEVENT.canonicalVersion,
    compiledHash: computeCompiledHash(MAP_214_STATUSEVENT),
    artifact: MAP_214_STATUSEVENT,
  });
  return { partner, connection, map };
}

export function runStoreContract(makeStore: () => Promise<Store> | Store) {
  let store: Store;
  beforeEach(async () => {
    store = await makeStore();
  });

  it('partners: create, get, list — and isolates tenants', async () => {
    const p = await store.createPartner('default', { name: 'Acme', scac: 'ACME' });
    expect(p.id).toMatch(/^ptr_/);
    expect(await store.getPartner('default', p.id)).toMatchObject({ name: 'Acme', scac: 'ACME' });
    expect((await store.listPartners('default')).length).toBe(1);
    // Cross-tenant reads must miss.
    expect(await store.getPartner('other', p.id)).toBeNull();
    expect((await store.listPartners('other')).length).toBe(0);
  });

  it('connections: create, get, list (filtered), update', async () => {
    const partner = await store.createPartner('default', { name: 'Acme' });
    const conn = await store.createConnection('default', {
      partnerId: partner.id,
      direction: 'inbound',
      transactionSet: '214',
      x12Version: '004010',
      connectivity: { type: 'as2' },
    });
    expect(conn.status).toBe('draft');
    expect(await store.getConnection('default', conn.id)).toMatchObject({ transactionSet: '214' });
    expect((await store.listConnections('default', { partnerId: partner.id })).length).toBe(1);
    expect((await store.listConnections('default', { status: 'production' })).length).toBe(0);
    const updated = await store.updateConnection('default', conn.id, { status: 'production' });
    expect(updated?.status).toBe('production');
  });

  it('samples: append and read back', async () => {
    const { connection } = await seedMap(store, 'default');
    expect(await store.addSamples('default', connection.id, ['A', 'B'])).toBe(2);
    expect(await store.addSamples('default', connection.id, ['C'])).toBe(3);
    expect(await store.getSamples('default', connection.id)).toEqual(['A', 'B', 'C']);
  });

  it('maps: create, fetch record + artifact, update status', async () => {
    const { map } = await seedMap(store, 'default');
    expect(map.status).toBe('draft');
    expect(map.compiledHash).toBe(computeCompiledHash(MAP_214_STATUSEVENT));
    const artifact = await store.getMapArtifact('default', map.id);
    expect(artifact?.transactionSet).toBe('214');
    const updated = await store.updateMap('default', map.id, { status: 'certified' });
    expect(updated?.status).toBe('certified');
    expect((await store.listMapsByConnection('default', map.connectionId)).length).toBe(1);
  });

  it('certifications: persist headline + full result blob', async () => {
    const { map, connection } = await seedMap(store, 'default');
    const cert = await store.createCertification('default', {
      mapId: map.id,
      connectionId: connection.id,
      result: makeResult(true),
    });
    expect(cert.passed).toBe(true);
    expect(cert.roundtripFidelity).toBe(1);
    expect(await store.getCertification('default', cert.id)).toMatchObject({ passed: true });
    const full = await store.getCertificationResult('default', cert.id);
    expect(full?.corpusHash).toBe('corpus_test');
  });

  it('transactions: create, list, dedup by control numbers, fetch blobs', async () => {
    const { connection, map } = await seedMap(store, 'default');
    const canonical = [
      {
        kind: 'StatusEvent' as const,
        canonicalVersion: '1' as const,
        shipmentId: '0510938',
        statusCode: 'X1',
        occurredAt: '2026-06-18T13:00:00',
      },
    ];
    const txn = await store.createTransaction('default', {
      connectionId: connection.id,
      mapId: map.id,
      direction: 'inbound',
      transactionSet: '214',
      controls: { isa: '000000001', gs: '1', st: '0001' },
      status: 'transformed',
      ackStatus: 'accepted',
      rawIn: 'ISA*...~',
      canonical,
    });
    expect(txn.id).toMatch(/^txn_/);
    expect(txn.processedAt).toBeDefined();

    expect(await store.getTransaction('default', txn.id)).toMatchObject({ status: 'transformed' });
    expect((await store.listTransactions('default', connection.id)).length).toBe(1);

    const dup = await store.findTransactionByControls('default', connection.id, {
      isa: '000000001',
      gs: '1',
      st: '0001',
    });
    expect(dup?.id).toBe(txn.id);
    const miss = await store.findTransactionByControls('default', connection.id, {
      isa: '000000099',
      gs: '1',
      st: '0001',
    });
    expect(miss).toBeNull();

    expect(await store.getTransactionRawIn('default', txn.id)).toBe('ISA*...~');
    expect((await store.getTransactionCanonical('default', txn.id))?.[0]).toMatchObject({
      shipmentId: '0510938',
    });
  });

  it('drift events: create, list, get, resolve', async () => {
    const { connection } = await seedMap(store, 'default');
    const ev = await store.createDriftEvent('default', {
      connectionId: connection.id,
      kind: 'changed_qualifier',
      detail: JSON.stringify({ decision: 'auto_applied' }),
      status: 'auto_applied',
      resolvedAt: 123,
    });
    expect(ev.id).toMatch(/^drf_/);
    expect(ev.resolvedAt).toBe(123);
    expect((await store.listDriftEvents('default', connection.id)).length).toBe(1);
    expect(await store.getDriftEvent('default', ev.id)).toMatchObject({ kind: 'changed_qualifier' });
    const applied = await store.updateDriftEvent('default', ev.id, { status: 'applied', resolvedAt: 456 });
    expect(applied?.status).toBe('applied');
    expect(applied?.resolvedAt).toBe(456);
  });

  it('idempotency: stores and replays a response', async () => {
    expect(await store.getIdempotent('default', 'k1')).toBeNull();
    await store.putIdempotent('default', 'k1', { status: 201, body: { ok: true } });
    expect(await store.getIdempotent('default', 'k1')).toEqual({ status: 201, body: { ok: true } });
    expect(await store.getIdempotent('other', 'k1')).toBeNull();
  });
}
