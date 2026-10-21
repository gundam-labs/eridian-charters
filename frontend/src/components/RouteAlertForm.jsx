import { useEffect, useState } from 'react';
import { publicApi, errText } from '../api';
import { ErrorAlert } from './ui';

/** "Tell me when a flight is listed" — saves a route alert (no account needed). */
export default function RouteAlertForm({ airports, from = '', to = '', compact = false }) {
  const [f, setF] = useState({ email: '', name: '', from_code: from, to_code: to, date_from: '', date_to: '', website: '' });
  const [state, setState] = useState({});
  useEffect(() => { setF(s => ({ ...s, from_code: from, to_code: to })); }, [from, to]);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    if (!f.from_code && !f.to_code) { setState({ error: 'Choose at least one city.' }); return; }
    setState({ saving: true });
    try {
      const r = await publicApi.post('/api/public/route-alerts', f);
      setState({ done: r.data?.existing ? 'You already have this alert — we’ll email you when a flight is listed.' : 'Alert saved. We’ll email you as soon as a matching flight is listed.' });
    } catch (err) {
      setState({ error: err.response?.status === 429 ? 'Too many alerts from this network — try again later.' : errText(err) });
    }
  };
  const cities = [...airports].sort((a, b) => String(a.city).localeCompare(String(b.city)));
  return (
    <form className={`card route-alert ${compact ? 'compact' : ''}`} onSubmit={submit} data-testid="route-alert">
      <div className="card-body">
        <div className="eyebrow">Route alerts</div>
        <h3 style={{ margin: '4px 0 6px' }}>Don’t see your route? Get an email when it’s listed.</h3>
        {state.done ? <div className="alert alert-ok" style={{ marginBottom: 0 }}>{state.done}</div> : (
          <>
            <div className="ra-grid">
              <div className="field"><label htmlFor="ra-from">From</label>
                <select id="ra-from" className="select" value={f.from_code} onChange={set('from_code')}>
                  <option value="">Any city</option>
                  {cities.map(a => <option key={a.code} value={a.code}>{a.city} ({a.code})</option>)}
                </select></div>
              <div className="field"><label htmlFor="ra-to">To</label>
                <select id="ra-to" className="select" value={f.to_code} onChange={set('to_code')}>
                  <option value="">Any city</option>
                  {cities.map(a => <option key={a.code} value={a.code} disabled={a.code === f.from_code}>{a.city} ({a.code})</option>)}
                </select></div>
              <div className="field"><label htmlFor="ra-d1">From date <span className="muted">— optional</span></label>
                <input id="ra-d1" className="input" type="date" value={f.date_from} onChange={set('date_from')} /></div>
              <div className="field"><label htmlFor="ra-d2">To date <span className="muted">— optional</span></label>
                <input id="ra-d2" className="input" type="date" min={f.date_from || undefined} value={f.date_to} onChange={set('date_to')} /></div>
              <div className="field ra-email"><label htmlFor="ra-email">Email</label>
                <input id="ra-email" className="input" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></div>
              <div className="field"><label htmlFor="ra-name">Name <span className="muted">— optional</span></label>
                <input id="ra-name" className="input" autoComplete="name" value={f.name} onChange={set('name')} /></div>
            </div>
            <div className="hp" aria-hidden="true"><input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></div>
            <div style={{ marginTop: 10 }}><ErrorAlert error={state.error} /></div>
            <button className="btn btn-primary" disabled={state.saving}>{state.saving ? 'Saving…' : 'Alert me'}</button>
            <span className="xs muted" style={{ marginLeft: 10 }}>One email per new flight. Stop any time from the email.</span>
          </>
        )}
      </div>
    </form>
  );
}
