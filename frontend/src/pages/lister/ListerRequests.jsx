import { useEffect, useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, Modal, Toast } from '../../components/ui';
import CancelModal from '../../components/CancelModal';
import { normLeg, legRoute, legWindow } from '../../lib/emptyLegs';
import { inr, fmtDateTime, humanize } from '../../lib/format';
import { ListerStatusBanner } from './ListerListings';

/** "Answer within 1 h 20 min" — refreshes every 30 s. */
export function Deadline({ at }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  if (!at) return null;
  const ms = new Date(at).getTime() - now;
  if (ms <= 0) return <span className="deadline over">Time to confirm has passed</span>;
  const mins = Math.ceil(ms / 60000);
  const text = mins >= 60 ? `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min` : `${mins} min`;
  return <span className={`deadline ${mins < 30 ? 'over' : mins < 60 ? 'soon' : 'ok'}`}>Answer within {text}</span>;
}

const PAY_LABEL = { authorized: 'Payment held', captured: 'Paid', refunded: 'Refunded', partially_refunded: 'Part refunded', released: 'Hold released' };
const PAYOUT_LABEL = { pending: 'Payout after the flight', due: 'Payout due', transferred: 'Paid out', paid: 'Paid out', cancelled: 'No payout' };

function PaymentLine({ p }) {
  if (!p) return null;
  return (
    <div className="xs" style={{ marginTop: 4 }}>
      <span className="strong">{PAY_LABEL[p.status] || p.status}</span> · {inr(p.amount)}
      {p.payout != null && p.status !== 'authorized' && <span className="muted"> · you get {inr(p.payout)} ({PAYOUT_LABEL[p.payout_status] || p.payout_status})</span>}
    </div>
  );
}

export default function ListerRequests() {
  const me = useFetch('/api/lister/me');
  const [status, setStatus] = useState('requested');
  const { data, error, loading, reload } = useFetch(`/api/lister/bookings${status ? `?status=${status}` : ''}`);
  const [confirming, setConfirming] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [actErr, setActErr] = useState('');
  const markFlown = async (b) => {
    setActErr('');
    try { await api.post(`/api/lister/bookings/${b.id}/complete`); setToast(`${b.booking_no} marked as flown — payout is now due`); reload(); }
    catch (e) { setActErr(errText(e)); }
  };
  const [toast, setToast] = useState('');
  const canDecide = me.data?.status === 'approved';
  const list = (Array.isArray(data) ? data : []).map(b => ({ ...b, leg: normLeg(b.leg) }));

  return (
    <>
      <PageHead eyebrow={me.data?.company || 'Lister'} title="Booking requests"
        sub="Travellers pay when they request — the money is held, and charged when you confirm. Unanswered requests lapse at the deadline and the traveller’s hold is released." />
      <ListerStatusBanner me={me.data} />
      <div className="filters">
        <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">All requests</option>
          {['requested', 'confirmed', 'completed', 'rejected', 'cancelled'].map(s => <option key={s} value={s}>{s === 'rejected' ? 'Declined' : s === 'completed' ? 'Flown' : humanize(s)}</option>)}
        </select>
      </div>
      <ErrorAlert error={error || actErr} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title={status === 'requested' ? 'No requests waiting' : 'No requests'}>
          When a traveller requests one of your live flights, it appears here and we email you.
        </Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table el-table">
            <thead><tr><th>Request</th><th>Flight</th><th>Traveller</th><th className="num">Pax</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.map(b => {
                const w = legWindow(b.leg);
                return (
                  <tr key={b.id}>
                    <td className="nowrap"><span className="strong">{b.booking_no}</span>
                      <div className="muted xs" style={{ marginTop: 4 }}>{fmtDateTime(b.created_at)}</div>
                      {b.status === 'requested' && b.respond_by && <div><Deadline at={b.respond_by} /></div>}</td>
                    <td className="nowrap"><strong>{legRoute(b.leg)}</strong> <span className="muted xs">{b.leg.leg_no}</span>
                      <div className="muted xs">{w.day} · {w.range} · {inr(b.leg.price_inr)}</div></td>
                    <td>
                      <div className="strong">{b.customer.name}{b.customer.company ? <span className="muted"> · {b.customer.company}</span> : null}</div>
                      {['confirmed', 'completed'].includes(b.status)
                        ? <div className="xs">{[b.customer.email, b.customer.phone].filter(Boolean).join(' · ')}</div>
                        : <div className="muted xs">Contact details shared once you confirm</div>}
                      {b.message && <div className="xs el-msg">“{b.message}”</div>}
                      {b.reject_reason && <div className="xs" style={{ color: 'var(--red-fg)' }}>{b.reject_reason}</div>}
                      <PaymentLine p={b.payment} />
                    </td>
                    <td className="num">{b.pax}</td>
                    <td><StatusPill status={b.status} label={b.status === 'rejected' ? 'Declined' : b.status === 'completed' ? 'Flown' : undefined} /></td>
                    <td className="right nowrap">
                      {b.status === 'requested' && (
                        <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button className="btn btn-sm btn-gold" disabled={!canDecide} onClick={() => setConfirming(b)}
                            title={canDecide ? '' : 'Your account must be approved to confirm bookings'}>Confirm</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setDeclining(b)}>Decline</button>
                        </div>
                      )}
                      {b.status === 'confirmed' && (
                        <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          {new Date(b.leg.depart_earliest) <= new Date() && <button className="btn btn-sm btn-gold" onClick={() => markFlown(b)}>Mark flown</button>}
                          <button className="btn btn-sm btn-danger" onClick={() => setCancelling(b)}>Cancel flight</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirming && <ConfirmModal booking={confirming} onClose={() => setConfirming(null)}
        onDone={(r) => { setConfirming(null); setStatus('confirmed'); setToast(`${r.booking_no} confirmed — the traveller has your contact details`); reload(); }} />}
      {cancelling && <CancelFlightModal booking={cancelling} onClose={() => setCancelling(null)}
        onDone={() => { setCancelling(null); setStatus('cancelled'); setToast('Flight cancelled — the traveller is refunded in full'); reload(); }} />}
      {declining && (
        <CancelModal title={`Decline ${declining.booking_no}`} confirmLabel="Decline request" path={`/api/lister/bookings/${declining.id}/reject`}
          warning={`${declining.customer.name} is emailed that the flight could not be confirmed, with your reason.`}
          onClose={() => setDeclining(null)} onDone={() => { setDeclining(null); setToast('Request declined'); reload(); }} />
      )}
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function ConfirmModal({ booking: b, onClose, onDone }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const w = legWindow(b.leg);

  const confirm = async () => {
    setSaving(true); setError('');
    try { const r = await api.post(`/api/lister/bookings/${b.id}/confirm`); onDone(r.data); }
    catch (err) { setError(errText(err)); setSaving(false); }
  };

  return (
    <Modal title={`Confirm ${b.booking_no}`} onClose={onClose}>
      <dl className="dl">
        <dt>Flight</dt><dd>{legRoute(b.leg)} · {b.leg.leg_no}</dd>
        <dt>Departure</dt><dd>{w.day}, {w.range} IST</dd>
        <dt>Traveller</dt><dd>{b.customer.name}{b.customer.company ? ` · ${b.customer.company}` : ''}</dd>
        <dt>Passengers</dt><dd>{b.pax}</dd>
        <dt>Your price</dt><dd>{inr(b.leg.price_inr)} + GST</dd>
      </dl>
      <div className="alert alert-info" style={{ marginTop: 16 }}>
        Confirming marks the flight booked, takes it off the deals page and declines any other requests on it.
        {b.payment?.status === 'authorized'
          ? <> The traveller’s held payment of <strong>{inr(b.payment.amount)}</strong> is charged now; you receive it less our commission after the flight.</>
          : ' Arrange payment with the traveller directly.'}
        {' '}You and the traveller receive each other’s contact details to arrange passenger details and the exact departure time.
      </div>
      <ErrorAlert error={error} />
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>Back</button>
        <button className="btn btn-gold" disabled={saving} onClick={confirm}>{saving ? 'Confirming…' : 'Confirm booking'}</button>
      </div>
    </Modal>
  );
}

const REASONS = [
  { value: 'charter_change', label: 'The main charter changed or was cancelled' },
  { value: 'weather_technical', label: 'Weather, ATC or a technical problem' },
  { value: 'other', label: 'Other reason' },
];

function CancelFlightModal({ booking: b, onClose, onDone }) {
  const [type, setType] = useState('charter_change');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!reason.trim()) { setError('Please explain briefly — the traveller sees this.'); return; }
    setSaving(true); setError('');
    try { await api.post(`/api/lister/bookings/${b.id}/cancel`, { reason_type: type, reason: reason.trim() }); onDone(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  };
  return (
    <Modal title={`Cancel ${b.booking_no}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="alert alert-warn">
          {b.customer.name} is refunded in full{b.payment ? ` (${inr(b.payment.amount)})` : ''} and there is no payout for this flight.
          Cancellations are recorded on your account.
        </div>
        <fieldset className="mock-methods" style={{ marginTop: 12 }}>
          <legend className="label">Why are you cancelling?</legend>
          {REASONS.map(r => (
            <label key={r.value} className={`mock-method ${type === r.value ? 'on' : ''}`}>
              <input type="radio" name="reason_type" value={r.value} checked={type === r.value} onChange={() => setType(r.value)} />
              <span><span className="t">{r.label}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="cf-reason">Message to the traveller</label>
          <textarea id="cf-reason" className="textarea" rows={3} value={reason} onChange={e => setReason(e.target.value)} />
        </div>
        <ErrorAlert error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-danger" disabled={saving}>{saving ? 'Cancelling…' : 'Cancel flight and refund'}</button>
        </div>
      </form>
    </Modal>
  );
}
