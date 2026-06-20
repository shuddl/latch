// M0 shell: confirms the control plane is reachable. The hero flow (Screens 1–4,
// docs/09) is built in M1.6 using the frontend-design skill (REVIEW.md D2).

import { useEffect, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8787';

export function App() {
  const [health, setHealth] = useState<string>('checking…');

  useEffect(() => {
    fetch(`${API}/v1/health`)
      .then((r) => r.json())
      .then((d) => setHealth(d.status === 'ok' ? 'API healthy ✓' : 'API unhealthy'))
      .catch(() => setHealth('API unreachable'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', maxWidth: 640 }}>
      <h1 style={{ letterSpacing: '-0.02em' }}>Latch</h1>
      <p style={{ color: '#555' }}>Two systems. One handshake. Zero integration cost.</p>
      <p>
        Control plane: <strong>{health}</strong>
      </p>
    </main>
  );
}
