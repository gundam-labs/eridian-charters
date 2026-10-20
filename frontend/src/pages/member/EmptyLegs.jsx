import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal } from '../../components/ui';
import EmptyLegCard, { RouteLine } from '../../components/EmptyLegCard';
import { normLeg, legWindow, flightTime } from '../../lib/emptyLegs';
import { inr } from '../../lib/format';
import { TERMS_TEXT } from '../public/EmptyLegPublicDetail';

export default function MemberEmptyLegs() {
  const { data, error, loading } = useFetch('/api/empty-legs');
  const [booking, setBooking] = useState(null);
  const legs = (Array.isArray(data) ? data : []).map(normLeg);

  return (
    <>
      <PageHead eyebrow="Member offers" title="Empty legs"
        sub="Whole-aircraft flights on positioning legs, at a fraction of the charter price. Book instantly as a member." />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : legs.length === 0 ? (
        <div className="card"><Empty title="No empty legs right now">New flights appear here as charters are confirmed.</Empty></div>
      ) : (
        <div className="el-grid">
          {legs.map(l => (
            <EmptyLegCard key={l.id} leg={l} action={l.request_only
              // Listed by an independent operator: they confirm, so members send a request like anyone else.
              ? <Link className="btn btn-block" to={`/empty-legs/${l.id}`}>Request from operator</Link>
              : (
                <button className="btn btn-gold btn-block" disabled={l.can_book === false} onClick={() => setBooking(l)}>
                  {l.can_book === false ? 'Not bookable' : 'Book now'}
                </button>
              )} />
          ))}
        </div>
      )}
      {booking && <BookModal leg={booking} onClose={() => setBooking(null)} />}
    </>
  );
}

function BookModal({ leg, onClose }) {
  const nav = useNavigate();
  const [pax, setPax] = useState('1');
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const w = legWindow(leg);

  const submit = async (e) => {
    e.preventDefault();
    if (!agree) { setError('Please accept the empty-leg terms.'); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post(`/api/empty-legs/${leg.id}/book`, { pax: Number(pax) });
      const cid = r.data?.charter?.id || r.data?.charter_id;
      nav(cid ? `/m/trips/${cid}?booked=1` : '/m/trips');
    } catch (err) { setError(errText(err)); setSaving(false); }
  };

  return (
    <Modal title="Book this empty leg" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="el-confirm">
          <RouteLine leg={leg} />
          <dl className="dl" style={{ marginTop: 14 }}>
            <dt>Departure</dt><dd>{w.day}, {w.range} IST</dd>
            <dt>Aircraft</dt><dd>{leg.aircraft_type} · {leg.seats} seats · {flightTime(leg.flight_hours)}</dd>
            <dt>Price</dt><dd>{inr(leg.price_inr)} + GST {leg.savings_pct > 0 && <span className="el-save sm">Save {leg.savings_pct}%</span>}</dd>
          </dl>
        </div>
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="b-pax">Passengers</label>
          <select id="b-pax" className="select" value={pax} onChange={e => setPax(e.target.value)}>
            {Array.from({ length: Math.max(1, leg.seats) }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select>
        </div>
        <label className="check el-terms">
          <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />
          <span>{TERMS_TEXT}</span>
        </label>
        <p className="hint" style={{ marginTop: 10 }}>Booking creates your trip and a GST invoice immediately. Add passenger details from the trip page.
          Payment is due 24 hours before departure — for flights leaving sooner, within 2 hours of booking, or the flight is released.</p>
        <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-gold" disabled={saving}>{saving ? 'Booking…' : `Book for ${inr(leg.price_inr)} + GST`}</button>
        </div>
      </form>
    </Modal>
  );
}
