// A calm circular gauge for a single proof metric (e.g. round-trip fidelity).
// Accessible: role=img with an aria-label stating the value and threshold.

interface GaugeProps {
  value: number; // 0..1
  threshold?: number; // 0..1; below → amber
  label: string;
  size?: number;
}

export function Gauge({ value, threshold = 0.999, label, size = 160 }: GaugeProps) {
  const pct = Math.max(0, Math.min(1, value));
  const passing = pct >= threshold;
  const stroke = passing ? 'var(--proven)' : 'var(--attention)';
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const dash = c * pct;

  return (
    <figure
      className="gauge"
      role="img"
      aria-label={`${label}: ${(pct * 100).toFixed(2)} percent${passing ? ', meets bar' : ', below bar'}`}
      style={{ margin: 0, width: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ink-100)" strokeWidth={10} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="48%"
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontSize: 26, fontWeight: 650, fill: 'var(--ink-900)' }}
        >
          {(pct * 100).toFixed(pct === 1 ? 0 : 2)}%
        </text>
        <text
          x="50%"
          y="63%"
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontSize: 11, fill: 'var(--ink-500)', letterSpacing: '0.04em', textTransform: 'uppercase' }}
        >
          {label}
        </text>
      </svg>
    </figure>
  );
}
