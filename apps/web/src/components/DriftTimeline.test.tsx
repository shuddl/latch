// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DriftTimeline } from './DriftTimeline';
import type { DriftEvent } from '../types';

afterEach(cleanup);

function ev(status: DriftEvent['status'], detailSummary: string): DriftEvent {
  return {
    id: `drf_${status}`,
    connectionId: 'con_1',
    kind: 'changed_qualifier',
    detail: JSON.stringify({ findings: [{ detail: detailSummary }], shadowPassed: true }),
    status,
    createdAt: 1_700_000_000_000,
  };
}

describe('DriftTimeline', () => {
  it('shows a calm steady state when there is no drift', () => {
    render(<DriftTimeline events={[]} />);
    expect(screen.getByText(/No drift/)).toBeTruthy();
  });

  it('renders an auto-applied event as relief with no action needed', () => {
    const { container } = render(<DriftTimeline events={[ev('auto_applied', 'New qualifier ZZ on L11')]} />);
    expect(screen.getByText('Caught a change')).toBeTruthy();
    expect(container.textContent).toContain('New qualifier ZZ on L11');
    expect(container.textContent).toContain('Nothing for you to do');
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
  });

  it('offers one-click apply when policy requires approval', () => {
    const onApprove = vi.fn();
    render(<DriftTimeline events={[ev('awaiting_approval', 'New segment N9')]} onApprove={onApprove} />);
    expect(screen.getByText('Needs your OK')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(onApprove).toHaveBeenCalledWith('drf_awaiting_approval');
  });
});
