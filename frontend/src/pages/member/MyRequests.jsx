import { Link } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill } from '../../components/ui';
import { fmtDateTime, route } from '../../lib/format';

export default function MyRequests() {
  const { data, error, loading } = useFetch('/api/quote-requests');
  const list = data || [];
  return (
    <>
      <PageHead eyebrow="Requests" title="My requests" actions={<Link to="/m/request" className="btn btn-primary">New request</Link>} />
      <ErrorAlert error={error} />
      {loading ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No requests yet" action={<Link to="/m/request" className="btn btn-primary">Request a quote</Link>}>Your quote requests and their proposals will appear here.</Empty></div>
      ) : (
        <div className="cards">
          {list.map(r => (
            <Link key={r.id} to={`/m/requests/${r.id}`} className="trip-card">
              <div className="top"><span className="date">{fmtDateTime(r.legs?.[0]?.depart_at)}</span><StatusPill status={r.status} /></div>
              <div className="route">{route(r.legs)}</div>
              <div className="meta"><span>{r.pax} pax</span><span>{r.legs?.length} leg{r.legs?.length === 1 ? '' : 's'}</span>
                {r.quote_count != null && <span>{r.quote_count} quote{Number(r.quote_count) === 1 ? '' : 's'}</span>}</div>
              <div className="ref" style={{ marginTop: 8 }}>{r.request_no}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
