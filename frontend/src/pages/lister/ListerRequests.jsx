import { useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, Modal, Toast } from '../../components/ui';
import CancelModal from '../../components/CancelModal';
import { normLeg, legRoute, legWindow } from '../../lib/emptyLegs';
import { inr, fmtDateTime, humanize } from '../../lib/format';
import { ListerStatusBanner } from './ListerListings';

export default function ListerRequests() {
  const me = useFetch('/api/lister/me');
  const [status, setStatus] = useState('requested');
  const { data, error, loading, reload } = useFetch(`/api/lister/bookings${status ? `?status=${status}` : ''}`);
  const [confirming, setConfirming] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [toast, setToast] = useState('');
  const canDecide = me.data?.status === 'approved';
  const list = (Array.isArray(data) ? data : []).map(b => ({ ...b, leg: normLeg(b.leg) }));

  return (
    <>
      <PageHead eyebrow={me.data?.company || 'Lister'} title="Booking requests"
        sub="Travellers request your flights here. Confirming books the flight and shares the traveller’s contact details with you." />
      <ListerStatusBanner me={me.data} />
      <div className="filters">
        <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">All requests</option>
          {['requested', 'confirmed', 'rejected', 'cancelled'].map(s => <option key={s} value={s}>{s === 'rejected' ? 'Declined' : humanize(s)}</option>)}
        </select>
      </div>
      <ErrorAlert error={error} />
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
                      <div className="muted xs" style={{ marginTop: 4 }}>{fmtDateTime(b.created_at)}</div></td>
                    <td className="nowrap"><strong>{legRoute(b.leg)}</strong> <span className="muted xs">{b.leg.leg_no}</span>
                      <div className="muted xs">{w.day} · {w.range} · {inr(b.leg.price_inr)}</div></td>
                    <td>
                      <div className="strong">{b.customer.name}{b.customer.company ? <span className="muted"> · {b.customer.company}</span> : null}</div>
                      {b.status === 'confirmed'
                        ? <div className="xs">{[b.customer.email, b.customer.phone].filter(Boolean).join(' · ')}</div>
                        : <div className="muted xs">Contact details shared once you confirm</div>}
                      {b.message && <div className="xs el-msg">“{b.message}”</div>}
                      {b.reject_reason && <div className="xs" style={{ color: 'var(--red-fg)' }}>{b.reject_reason}</div>}
                    </td>
                    <td className="num">{b.pax}</td>
                    <td><StatusPill status={b.status} label={b.status === 'rejected' ? 'Declined' : undefined} /></td>
                    <td className="right nowrap">
                      {b.status === 'requested' && (
                        <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button className="btn btn-sm btn-gold" disabled={!canDecide} onClick={() => setConfirming(b)}
                            title={canDecide ? '' : 'Your account must be approved to confirm bookings'}>Confirm</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setDeclining(b)}>Decline</button>
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
        The traveller gets your contact details and you get theirs — arrange payment, passenger details and the exact departure time directly.
      </div>
      <ErrorAlert error={error} />
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>Back</button>
        <button className="btn btn-gold" disabled={saving} onClick={confirm}>{saving ? 'Confirming…' : 'Confirm booking'}</button>
      </div>
    </Modal>
  );
}
