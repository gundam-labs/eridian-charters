import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { publicApi, errText } from '../../api';
import { ErrorAlert, Loading, Empty, StatusPill } from '../../components/ui';
import { RouteLine } from '../../components/EmptyLegCard';
import PublicLayout from './PublicLayout';
import MockHoldCheckout, { openRazorpayHold } from '../../components/HoldCheckout';
import { normLeg, legWindow, useDocumentTitle } from '../../lib/emptyLegs';
import { inr, fmtDateTime } from '../../lib/format';

const HEAD = {
  pending_payment: ['Payment not finished', 'Complete the payment to send your request to the operator.'],
  requested: ['Waiting for the operator', 'Your payment is held, not charged.'],
  confirmed: ['Confirmed', 'Your flight is booked and your payment has been charged.'],
  completed: ['Flown', 'Thank you for flying with us.'],
  rejected: ['Not confirmed', 'You have not been charged.'],
  cancelled: ['Cancelled', ''],
  expired: ['Request closed', 'You have not been charged.'],
};
const PAY = { created: 'Not paid yet', authorized: 'Held (not charged)', captured: 'Charged', released: 'Hold released', refunded: 'Refunded', partially_refunded: 'Partly refunded', expired: 'Not paid' };

/** Traveller's page for a request on an operator's flight — reached after paying, and by the link in emails. */
export default function BookingStatus() {
  const { token } = useParams();
  const [b, setB] = useState(null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [paying, setPaying] = useState(null);
  const [params, setParams] = useSearchParams();
  useDocumentTitle(b ? `Request ${b.booking_no} · Meridian Charters` : 'Your request · Meridian Charters');

  const load = () => publicApi.get(`/api/public/bookings/${encodeURIComponent(token)}`)
    .then(r => setB(r.data)).catch(e => (e.response?.status === 404 ? setNotFound(true) : setError(errText(e))));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // While waiting on the operator, refresh every 30 s.
  useEffect(() => {
    if (b?.status !== 'requested') return undefined;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [b?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const leg = b ? normLeg(b.leg) : null;
  const pay = async () => {
    setError('');
    if (b.payment.provider === 'mock') { setPaying(b.payment); return; }
    try { setB(await openRazorpayHold({ token, payment: b.payment, leg })); }
    catch (e) { if (!e.dismissed) setError(e.message); }
  };
  // Arriving straight from the request form: open the checkout at once.
  useEffect(() => {
    if (params.get('pay') && b?.status === 'pending_payment' && b.payment?.status === 'created') {
      setParams({}, { replace: true });
      pay();
    }
  }, [b]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PublicLayout>
      <main className="pub-main pub-detail" style={{ maxWidth: 760 }}>
        <Link to="/empty-legs" className="back">← All empty-leg flights</Link>
        <ErrorAlert error={error} />
        {notFound ? (
          <div className="card" style={{ marginTop: 16 }}><Empty title="Request not found">Check the link in your email.</Empty></div>
        ) : !b ? (!error && <Loading label="Loading your request…" />) : (
          <div className="card" style={{ marginTop: 16 }} data-testid="booking-status">
            <div className="card-body">
              <div className="eyebrow">Request {b.booking_no}</div>
              <h1 style={{ margin: '6px 0 4px' }}>{HEAD[b.status]?.[0] || b.status}</h1>
              <p className="muted" style={{ marginTop: 0 }}>{b.status === 'cancelled' && b.payment?.refunded > 0
                ? `${inr(b.payment.refunded)} has been refunded to your payment method.` : HEAD[b.status]?.[1]}</p>
              {b.status === 'requested' && b.respond_by && (
                <div className="alert alert-info">
                  <strong>{leg.operated_by}</strong> has until <strong>{fmtDateTime(b.respond_by)} IST</strong> to confirm.
                  If they don’t, the hold on your payment is released automatically.
                </div>
              )}
              {['rejected', 'expired'].includes(b.status) && b.reject_reason && <div className="alert alert-warn">{b.reject_reason}</div>}
              <div style={{ margin: '18px 0' }}><RouteLine leg={leg} /></div>
              <dl className="dl">
                <dt>Departure</dt><dd>{legWindow(leg).day}, {legWindow(leg).range} IST</dd>
                <dt>Aircraft</dt><dd>{leg.aircraft_type} · {b.pax} passenger{b.pax > 1 ? 's' : ''}</dd>
                <dt>Operated by</dt><dd>{leg.operated_by}</dd>
                {b.payment && <><dt>Payment</dt><dd>{inr(b.payment.amount)} incl. GST · <StatusPill status={b.payment.status} label={PAY[b.payment.status]} /></dd></>}
              </dl>
              {b.status === 'pending_payment' && b.payment?.status === 'created' && (
                <button className="btn btn-gold btn-block" style={{ marginTop: 18 }} onClick={pay}>Pay {inr(b.payment.amount)} to send the request</button>
              )}
              {b.status === 'confirmed' && <p className="small" style={{ marginTop: 16 }}>The operator will contact you about passenger details and the exact departure time.</p>}
            </div>
          </div>
        )}
        {paying && <MockHoldCheckout token={token} payment={paying} onClose={() => setPaying(null)} onAuthorised={(v) => { setPaying(null); setB(v); }} />}
      </main>
    </PublicLayout>
  );
}
