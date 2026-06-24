// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CertificationReport } from './CertificationReport';
import type { CertificationReportData } from '../types';
import type { CertificationResult } from '@latch/verify';

afterEach(cleanup);

const dim = (value: number, threshold = 1) => ({ value, threshold, passed: value >= threshold });

function makeData(passed: boolean): CertificationReportData {
  const result: CertificationResult = {
    mapHash: 'map_abcdef0123456789',
    corpusHash: 'corpus_x',
    passed,
    dimensions: {
      requiredSegmentCoverage: dim(passed ? 1 : 0.8),
      qualifierCoverage: dim(1),
      loopCoverage: dim(1),
      roundTripFidelity: dim(passed ? 1 : 0.97, 0.999),
      adversarialGraceful: dim(1),
      deviationHandling: dim(1),
    },
    records: [
      { name: 'fixture-214-001', category: 'valid', roundTrip: passed, fidelity: passed ? 1 : 0.97, forwardMatch: passed, differentialMatch: true, issues: passed ? [] : ['statusCode differs'] },
      { name: 'qual-BM', category: 'qualifier', roundTrip: true, fidelity: 1, forwardMatch: true, differentialMatch: true, issues: [] },
      { name: 'adv-truncated', category: 'adversarial', roundTrip: false, fidelity: 0, graceful: true, issues: [] },
    ],
    shortfalls: passed ? [] : ['Required-segment coverage 80% — AT7 status not exercised'],
  };
  return {
    certification: {
      id: 'crt_1',
      mapId: 'map_abcdef0123456789',
      connectionId: 'con_1',
      passed,
      requiredCoverage: passed ? 1 : 0.8,
      qualifierCoverage: 1,
      loopCoverage: 1,
      roundtripFidelity: passed ? 1 : 0.97,
      adversarialOk: 1,
      deviationHandling: 1,
      shortfalls: result.shortfalls,
      mapHash: 'map_abcdef0123456789',
      corpusHash: 'corpus_x',
      createdAt: 0,
    },
    result,
  };
}

describe('CertificationReport', () => {
  it('renders a passing certification with a Go-live action', () => {
    const { container } = render(<CertificationReport data={makeData(true)} />);
    expect(screen.getByText('Certified')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Go live/ })).toBeTruthy();
    expect(container.textContent).toContain('safely rejected with reasons');
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
  });

  it('renders a below-bar certification with shortfalls and no go-live', () => {
    render(<CertificationReport data={makeData(false)} />);
    expect(screen.getByText('Below bar')).toBeTruthy();
    expect(screen.getByText(/AT7 status not exercised/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Go live/ })).toBeNull();
  });

  it('drills into a corpus case on click', () => {
    render(<CertificationReport data={makeData(true)} />);
    // The case name lives in the cell's aria-label until selected; clicking reveals it.
    expect(screen.queryByText('fixture-214-001')).toBeNull();
    fireEvent.click(screen.getByLabelText(/fixture-214-001/));
    expect(screen.getByText('fixture-214-001')).toBeTruthy();
  });
});
