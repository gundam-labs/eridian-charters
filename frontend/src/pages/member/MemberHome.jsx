import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { ErrorAlert, Empty, Loading } from '../../components/ui';
import TripCard from '../../components/TripCard';
import { countOf, inr } from '../../lib/format';

export default function MemberHome() {
  const { user } = useAuth();
  const { data, error, loading } = useFetch('/api/dashboard/member');
  const upcoming = Array.isArray(data?.upcoming_charters) ? data.upcoming_charters : null;
  const unpaid = data?.unpaid_invoices;
  const unpaidCount = Array.isArray(unpaid) ? unpaid.length : Number(unpaid?.count ?? unpaid ?? 0);
  const unpaidTotal = Array.isArray(unpaid) ? unpaid.reduce((s, i) => s + Number(i.total || 0), 0) : Number(unpaid?.total || 0);
  const toReview = countOf(data?.quotes_awaiting_decision);

  return (
    <>
      <div className="hero">
        <div className="eyebrow">Welcome back{user?.member_no ? ` · ${user.member_no}` : ''}</div>
        <h1>Good to see you, {user?.name?.split(' ')[0] || 'there'}.</h1>
        <p style={{ marginTop: 10 }}>Tell us where you’d like to go and our charter desk will come back with a priced proposal.</p>
        <Link to="/m/request" className="btn btn-gold" style={{ marginTop: 10 }}>Request a quote</Link>
      </div>
      <ErrorAlert error={error} />
      {loading ? <Loading /> : data && (
        <>
          <div className="stats">
            <Link to="/m/trips" className="stat"><div className="label">Upcoming trips</div><div className="value">{countOf(data.upcoming_charters)}</div></Link>
            <Link to="/m/requests" className="stat"><div className="label">Open requests</div><div className="value">{countOf(data.open_requests)}</div></Link>
            <Link to="/m/requests" className="stat"><div className="label">Quotes to review</div><div className="value">{countOf(data.quotes_awaiting_decision)}</div></Link>
            <Link to="/m/invoices" className="stat">
              <div className="label">Unpaid invoices</div><div className="value">{unpaidCount}</div>
              {unpaidTotal ? <div className="hint">{inr(unpaidTotal)} outstanding</div> : null}
            </Link>
          </div>
          {toReview > 0 && (
            <div className="alert alert-info">
              You have {toReview} quote{toReview > 1 ? 's' : ''} awaiting your decision.{' '}
              <Link to="/m/requests">Review now →</Link>
            </div>
          )}
          <h2 style={{ margin: '8px 0 14px' }}>Upcoming trips</h2>
          {upcoming && upcoming.length > 0 ? (
            <div className="cards">{upcoming.map(c => <TripCard key={c.id} charter={c} to={`/m/trips/${c.id}`} />)}</div>
          ) : (
            <div className="card"><Empty title="No upcoming trips" action={<Link to="/m/request" className="btn btn-primary">Plan a trip</Link>}>Once you accept a quote, your trip appears here.</Empty></div>
          )}
        </>
      )}
    </>
  );
}
