import { Link } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill } from '../../components/ui';
import { fmtDateTime, route, aircraftReg, aircraftType, paxCount, fmtTime } from '../../lib/format';
import { crewName } from '../../lib/normalize';

export default function MyFlights() {
  const { data, error, loading } = useFetch('/api/pilot/flights');
  const list = data || [];
  const byStart = (a, b) => String(a.starts_on || '').localeCompare(String(b.starts_on || ''));
  const upcoming = list.filter(c => !['flown', 'closed', 'cancelled'].includes(c.status)).sort(byStart);
  const past = list.filter(c => ['flown', 'closed', 'cancelled'].includes(c.status)).sort((a, b) => byStart(b, a));
  return (
    <>
      <PageHead eyebrow="Flight deck" title="My flights" />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No flights assigned">Flights you’re rostered on will appear here.</Empty></div>
      ) : (
        <>
          {upcoming.length === 0 ? <div className="card"><Empty title="Nothing upcoming">No upcoming flights assigned.</Empty></div>
            : <div className="cards">{upcoming.map(c => <FlightCard key={c.id} c={c} />)}</div>}
          {past.length > 0 && <>
            <h2 style={{ margin: '28px 0 14px' }}>Completed</h2>
            <div className="cards">{past.map(c => <FlightCard key={c.id} c={c} />)}</div>
          </>}
        </>
      )}
    </>
  );
}

function FlightCard({ c }) {
  const first = c.legs?.[0];
  const crew = [crewName(c, 'captain'), crewName(c, 'first_officer'), crewName(c, 'cabin_crew')].filter(Boolean);
  const needsLog = c.status === 'manifest_complete';
  return (
    <Link to={`/p/flights/${c.id}`} className="trip-card">
      <div className="top"><span className="date">{first ? fmtDateTime(first.depart_at) : c.starts_on}</span><StatusPill status={c.status} /></div>
      <div className="route">{route(c.legs)}</div>
      <div className="meta">
        <span className="strong">{aircraftReg(c)}</span><span>{aircraftType(c)}</span><span>{paxCount(c)} pax</span>
      </div>
      {c.legs?.length > 1 && <div className="muted xs" style={{ marginTop: 6 }}>{c.legs.map(l => `${l.from} ${fmtTime(l.depart_at)}`).join(' · ')}</div>}
      {crew.length > 0 && <div className="muted small" style={{ marginTop: 6 }}>{crew.join(' · ')}</div>}
      {needsLog && <div className="pill pill-gold" style={{ marginTop: 10 }}>Flight log due after landing</div>}
      <div className="ref" style={{ marginTop: 8 }}>{c.charter_no}</div>
    </Link>
  );
}
