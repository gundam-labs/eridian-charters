import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { ErrorAlert, Empty, Loading } from '../../components/ui';
import TripCard from '../../components/TripCard';
import { countOf, inr } from '../../lib/format';
import { invoiceMoney, isPayable, dueInfo } from '../../lib/payments';

export default function MemberHome() {
  const { user } = useAuth();
  const { data, error, loading } = useFetch('/api/dashboard/member');
  const upcoming = Array.isArray(data?.upcoming_charters) ? data.upcoming_charters : null;
  const unpaid = data?.unpaid_invoices;
  // Balances and deadlines come from the invoices themselves (part payments make dashboard totals approximate).
  const invs = useFetch('/api/invoices');
  const payable = Array.isArray(invs.data) ? invs.data.filter(isPayable) : null;
  const unpaidCount = payable ? payable.length : Number(unpaid?.count ?? (Array.isArray(unpaid) ? unpaid.length : unpaid) ?? 0);
  const unpaidTotal = payable ? payable.reduce((s, i) => s + invoiceMoney(i).balance, 0) : Number(unpaid?.balance ?? unpaid?.total ?? 0);
  const nextDue = (payable || []).filter(i => i.due_at && new Date(i.due_at) > Date.now())
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at))[0];
  const nextDueInfo = nextDue ? dueInfo(nextDue) : null;
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
              <div className="label">Payments due</div><div className="value">{unpaidCount}</div>
              {unpaidTotal ? <div className="hint">{inr(unpaidTotal)} outstanding</div> : null}
            </Link>
          </div>
          {nextDueInfo && (
            <div className={`alert ${nextDueInfo.urgency === 'ok' ? 'alert-info' : 'alert-warn'}`} data-testid="home-pay-due">
              <strong>{inr(invoiceMoney(nextDue).balance)}</strong> due by {nextDueInfo.label} ({nextDueInfo.left}){nextDue.charter_no ? ` for ${nextDue.charter_no}` : ''}.{' '}
              <Link to={nextDue.charter_id ? `/m/trips/${nextDue.charter_id}` : '/m/invoices'}>Pay now →</Link>
            </div>
          )}
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
