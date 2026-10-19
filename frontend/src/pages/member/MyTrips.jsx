import { Link } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty } from '../../components/ui';
import TripCard from '../../components/TripCard';

export default function MyTrips() {
  const { data, error, loading } = useFetch('/api/charters');
  const list = data || [];
  const active = list.filter(c => !['flown', 'closed', 'cancelled'].includes(c.status));
  const past = list.filter(c => ['flown', 'closed', 'cancelled'].includes(c.status));
  return (
    <>
      <PageHead eyebrow="Trips" title="My trips" />
      <ErrorAlert error={error} />
      {loading ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No trips yet" action={<Link to="/m/request" className="btn btn-primary">Request a quote</Link>}>Accepted quotes become trips here.</Empty></div>
      ) : (
        <>
          <h2 style={{ marginBottom: 14 }}>Upcoming</h2>
          {active.length ? <div className="cards">{active.map(c => <TripCard key={c.id} charter={c} to={`/m/trips/${c.id}`} />)}</div>
            : <div className="card"><Empty title="Nothing upcoming">Your next trip will appear here.</Empty></div>}
          {past.length > 0 && <>
            <h2 style={{ margin: '28px 0 14px' }}>Past &amp; cancelled</h2>
            <div className="cards">{past.map(c => <TripCard key={c.id} charter={c} to={`/m/trips/${c.id}`} />)}</div>
          </>}
        </>
      )}
    </>
  );
}
