import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { publicApi, errText } from '../../api';
import { ErrorAlert, Loading, Empty } from '../../components/ui';
import EmptyLegCard from '../../components/EmptyLegCard';
import RouteAlertForm from '../../components/RouteAlertForm';
import PublicLayout from './PublicLayout';
import { normLeg, monthOptions, useDocumentTitle } from '../../lib/emptyLegs';
import { inr } from '../../lib/format';

function usePublicLegs(qs) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    publicApi.get(`/api/public/empty-legs${qs ? `?${qs}` : ''}`)
      .then(r => live && setState({ data: (Array.isArray(r.data) ? r.data : []).map(normLeg), error: '', loading: false }))
      .catch(e => live && setState({ data: null, error: errText(e), loading: false }));
    return () => { live = false; };
  }, [qs]);
  return state;
}

const STEPS = [
  ['The jet flies anyway', 'Before or after a charter, aircraft often reposition with every seat empty. We list those flights here.'],
  ['You take the whole aircraft', 'Request the flight for up to the full cabin — at a fraction of the normal charter price, plus GST.'],
  ['We confirm and you fly', 'Our charter desk confirms availability, sends your invoice and sets up your account for the trip.'],
];

export default function EmptyLegsPublic() {
  useDocumentTitle('Empty-leg private jet deals · Meridian Charters');
  const [params, setParams] = useSearchParams();
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const month = params.get('month') || '';
  const qs = new URLSearchParams(Object.entries({ from, to, month }).filter(([, v]) => v)).toString();

  const all = usePublicLegs('');
  const [airportList, setAirportList] = useState([]);
  useEffect(() => { publicApi.get('/api/public/airports').then(r => setAirportList(r.data || [])).catch(() => {}); }, []);
  const filtered = usePublicLegs(qs);
  const legs = qs ? filtered.data : all.data;
  const loading = qs ? filtered.loading : all.loading;
  const error = qs ? filtered.error : all.error;

  const airports = useMemo(() => {
    const m = { from: new Map(), to: new Map() };
    (all.data || []).forEach(l => {
      m.from.set(l.from_code, l.from_city || l.from_code);
      m.to.set(l.to_code, l.to_city || l.to_code);
    });
    const sort = (mp) => [...mp.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    return { from: sort(m.from), to: sort(m.to) };
  }, [all.data]);

  const stats = useMemo(() => {
    const d = all.data || [];
    const maxSave = d.reduce((mx, l) => Math.max(mx, l.savings_pct || 0), 0);
    const minPrice = d.reduce((mn, l) => (l.price_inr != null && (mn === null || l.price_inr < mn) ? l.price_inr : mn), null);
    return { maxSave, minPrice, count: d.length, routes: new Set(d.map(l => `${l.from_code}-${l.to_code}`)).size };
  }, [all.data]);

  const setFilter = (k) => (e) => {
    const next = new URLSearchParams(params);
    if (e.target.value) next.set(k, e.target.value); else next.delete(k);
    setParams(next, { replace: true });
  };
  const clear = () => setParams({}, { replace: true });
  const months = monthOptions(6);
  const headline = stats.maxSave >= 10 ? stats.maxSave : 60;

  return (
    <PublicLayout>
      <section className="pub-hero">
        <div className="pub-hero-inner">
          <div className="eyebrow">Empty-leg flights · No membership needed</div>
          <h1>Private jets at up to <em>{headline}% off</em>.</h1>
          <p className="lead">
            When a Meridian jet repositions between charters, the cabin is empty. Take the whole aircraft for that
            flight — Challenger, Praetor or Gulfstream — at a fraction of the usual charter fare.
          </p>
          <div className="pub-hero-facts">
            <div><strong>{all.data ? stats.count : '—'}</strong><span>flights listed</span></div>
            <div><strong>{stats.minPrice != null ? inr(stats.minPrice) : '—'}</strong><span>from, + GST</span></div>
            <div><strong>{all.data ? `${headline}%` : '—'}</strong><span>max saving</span></div>
          </div>
          <a href="#deals" className="btn btn-gold pub-hero-cta">See available flights</a>
        </div>
        <div className="pub-hero-arc" aria-hidden="true" /><div className="pub-hero-arc two" aria-hidden="true" />
      </section>

      <main className="pub-main" id="deals">
        <form className="el-filters" onSubmit={e => e.preventDefault()} aria-label="Filter flights">
          <div className="field">
            <label htmlFor="f-from">From</label>
            <select id="f-from" className="select" value={from} onChange={setFilter('from')}>
              <option value="">Any city</option>
              {airports.from.map(([c, city]) => <option key={c} value={c}>{city} ({c})</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-to">To</label>
            <select id="f-to" className="select" value={to} onChange={setFilter('to')}>
              <option value="">Any city</option>
              {airports.to.map(([c, city]) => <option key={c} value={c}>{city} ({c})</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-month">Month</label>
            <select id="f-month" className="select" value={month} onChange={setFilter('month')}>
              <option value="">Any time</option>
              {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          {qs && <button type="button" className="btn btn-ghost el-clear" onClick={clear}>Clear</button>}
        </form>

        <div className="el-list-head">
          <h2>{qs ? 'Matching flights' : 'Available flights'}</h2>
          {legs && <span className="muted small">{legs.length} flight{legs.length === 1 ? '' : 's'} · soonest first</span>}
        </div>

        <ErrorAlert error={error} />
        {loading && !legs ? <Loading label="Finding flights…" /> : legs && legs.length === 0 ? (
          <div className="card">
            <Empty title={qs ? 'No flights match' : 'No empty legs listed right now'}
              action={qs ? <button className="btn btn-primary" onClick={clear}>Show all flights</button> : null}>
              {qs ? 'Try another city or month — new flights are listed as charters are confirmed.'
                : 'New flights appear as charters are confirmed. Check back soon.'}
            </Empty>
          </div>
        ) : legs && (
          <div className="el-grid">
            {legs.map(l => <EmptyLegCard key={l.id} leg={l} to={`/empty-legs/${l.id}`} />)}
          </div>
        )}

        {airportList.length > 0 && <div style={{ marginTop: 28 }}><RouteAlertForm airports={airportList} from={from} to={to} /></div>}

        <section className="el-how" aria-labelledby="how-title">
          <div className="eyebrow">How empty legs work</div>
          <h2 id="how-title">A full private jet, on a flight that was going anyway.</h2>
          <ol className="el-steps">
            {STEPS.map(([t, d], i) => (
              <li key={t}>
                <span className="n">{i + 1}</span>
                <h3>{t}</h3>
                <p>{d}</p>
              </li>
            ))}
          </ol>
          <p className="small muted" style={{ marginTop: 18, marginBottom: 0 }}>
            Empty legs depend on the operator’s main charter, so timings sit within a departure window and may be retimed or withdrawn.
          </p>
        </section>
      </main>
    </PublicLayout>
  );
}
