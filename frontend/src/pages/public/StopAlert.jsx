import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { publicApi, errText } from '../../api';
import { Loading } from '../../components/ui';
import PublicLayout from './PublicLayout';

/** One-click unsubscribe from a route alert (link in every alert email). */
export default function StopAlert() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    publicApi.post(`/api/public/route-alerts/stop/${encodeURIComponent(token)}`)
      .then(r => setState({ ok: true, route: [r.data.from_code || 'any city', r.data.to_code || 'any city'].join(' → ') }))
      .catch(e => setState({ error: errText(e) }));
  }, [token]);
  return (
    <PublicLayout>
      <main className="pub-main" style={{ maxWidth: 560 }}>
        <div className="card card-pad" style={{ marginTop: 24 }}>
          {state.loading ? <Loading label="Stopping your alert…" /> : state.ok ? (
            <>
              <h1 style={{ marginBottom: 8 }}>Alert stopped</h1>
              <p className="muted">You won’t get more emails for {state.route}.</p>
            </>
          ) : (
            <>
              <h1 style={{ marginBottom: 8 }}>Link not valid</h1>
              <p className="muted">{state.error}</p>
            </>
          )}
          <Link to="/empty-legs" className="btn" style={{ marginTop: 12 }}>See available flights</Link>
        </div>
      </main>
    </PublicLayout>
  );
}
