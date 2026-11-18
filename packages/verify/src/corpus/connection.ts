// The per-connection golden corpus (docs/07 "Golden Record Synthesis", step 1).
//
// Every sample the operator uploaded becomes a golden record, and each one MUST carry an
// operator-confirmed expected canonical before the map can certify. The set's reference
// corpus (standard-conformant synthetic + adversarial cases) is kept for coverage, but its
// built-in expected output is only trusted for the exact reference fixture it was written
// for — never attached to a partner's own file.
//
// LATCH-ASSUMPTION: coverage targets and the synthetic coverage cases still come from the
// set's reference corpus (the X12 standard), not from the partner's own guide. Deriving
// them from the Latch Spec is the remaining part of golden synthesis (TASKS.md 1.4).

import type { CanonicalRecord } from '@latch/canonical';
import type { GoldenCorpus, GoldenRecord } from '../types';

/** One uploaded sample plus its operator-confirmed expected output, if any. */
export interface SampleAnchor {
  input: string;
  expectedCanonical?: CanonicalRecord[];
}

/** The reference fixtures the hand-authored expected outputs were written for (fixtures/*).
 *  A test pins each to the on-disk file. */
export const REFERENCE_FIXTURES: Readonly<Record<string, string>> = {
  '214':
    'ISA*00*          *00*          *ZZ*SHIPPERID      *ZZ*CARRIERID      *260618*1305*U*00401*000000001*0*P*>~GS*QM*SHIPPERID*CARRIERID*20260618*1305*1*X*004010~ST*214*0001~B10*4938294*0510938*SCAC~L11*BOL12345*BM~LX*1~AT7*X1*NS***20260618*1300*LT~MS1*MEMPHIS*TN*US~SE*7*0001~GE*1*1~IEA*1*000000001~',
  '990':
    'ISA*00*          *00*          *ZZ*CARRIERID      *ZZ*SHIPPERID      *260618*1310*U*00401*000000002*0*P*>~GS*GF*CARRIERID*SHIPPERID*20260618*1310*2*X*004010~ST*990*0001~B1*SCAC*SHIP78001*20260618*A~SE*3*0001~GE*1*2~IEA*1*000000002~',
  '204':
    'ISA*00*          *00*          *ZZ*SHIPPERID      *ZZ*CARRIERID      *260620*0900*U*00401*000000010*0*P*>~GS*SM*SHIPPERID*CARRIERID*20260620*0900*10*X*004010~ST*204*0001~B2**SCAC**SHIPABC123**PP~B2A*00~L11*ORDER789*OW~S5*1*CL~G62*69*20260620~N1*SH*ACME SHIPPING CO*93*ACME01~N3*100 MAIN ST~N4*CHICAGO*IL*60601*US~AT8*G*L*15000*40~S5*2*CU~N1*CN*BETA RECEIVING*93*BETA01~N3*200 OAK AVE~N4*DALLAS*TX*75201*US~AT8*G*L*15000*40~SE*16*0001~GE*1*10~IEA*1*000000010~',
  '210':
    'ISA*00*          *00*          *ZZ*CARRIERID      *ZZ*SHIPPERID      *260622*1750*U*00401*000000020*0*P*>~GS*IM*CARRIERID*SHIPPERID*20260622*1750*20*X*004010~ST*210*0001~B3**INV55001*SHIP44001*PP**20260622*1750.50***SCAC~C3*USD~N1*BT*PAYER LOGISTICS*93*PAY01~N3*900 DOCK RD~N4*MEMPHIS*TN*38101*US~L1*1**FR*1500.00****400~L1*2**FR*250.50****FUE~SE*9*0001~GE*1*20~IEA*1*000000020~',
  '211':
    'ISA*00*          *00*          *ZZ*SHIPPERID      *ZZ*CARRIERID      *260623*1430*U*00401*000000030*0*P*>~GS*BL*SHIPPERID*CARRIERID*20260623*1430*30*X*004010~ST*211*0001~BOL*SCAC*PP*BOL77001*20260623*1430~B2A*00~L11*BOL77001*BM~L11*PO99001*PO~G62*86*20260623~N1*SH*ACME SHIPPING CO*93*ACME01~N3*100 MAIN ST~N4*CHICAGO*IL*60601*US~N1*CN*BETA RECEIVING*93*BETA01~N3*200 OAK AVE~N4*DALLAS*TX*75201*US~N1*BT*PAYER LOGISTICS*93*PAY01~N3*900 DOCK RD~N4*MEMPHIS*TN*38101*US~AT1*1~AT2*40*PLT*G*15000*L*70~AT3*1500.00~AT4*PALLETIZED CONSUMER GOODS~SE*20*0001~GE*1*30~IEA*1*000000030~',
};

/**
 * Build the corpus that certifies one connection's map.
 *
 * @param buildReference the set's reference-corpus builder (e.g. `buildCorpus214`)
 * @param referenceFixture the exact fixture text that builder's expected output describes
 * @param samples the connection's uploaded samples with any confirmed expectations
 */
export function buildConnectionCorpus(
  buildReference: (fixtureText: string) => GoldenCorpus,
  referenceFixture: string,
  samples: SampleAnchor[],
): GoldenCorpus {
  const reference = buildReference(referenceFixture);
  const builtIn = reference.records.find((r) => r.input === referenceFixture)?.expectedCanonical;

  const sampleRecords: GoldenRecord[] = samples.map((s, i) => {
    // A confirmation always wins; the built-in expectation applies ONLY to the byte-identical
    // reference fixture (it was hand-verified for exactly that text).
    const expected = s.expectedCanonical ?? (s.input === referenceFixture ? builtIn : undefined);
    return {
      name: `sample ${i + 1}`,
      category: 'valid',
      input: s.input,
      requireAnchor: true,
      ...(expected ? { expectedCanonical: expected } : {}),
    };
  });

  // Reference cases stay for coverage, minus any that duplicate a sample, and WITHOUT their
  // standard-layout expectation (a partner-specific map must not be graded against it).
  const sampleInputs = new Set(samples.map((s) => s.input));
  const coverageRecords: GoldenRecord[] = reference.records
    .filter((r) => !sampleInputs.has(r.input))
    .map((r) => {
      const { expectedCanonical: _dropped, ...rest } = r;
      void _dropped;
      return { ...rest, name: `reference: ${r.name}` };
    });

  return {
    transactionSet: reference.transactionSet,
    records: [...sampleRecords, ...coverageRecords],
    coverage: reference.coverage,
  };
}
