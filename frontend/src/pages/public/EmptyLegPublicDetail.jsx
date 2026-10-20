import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { publicApi, errText } from '../../api';
import { ErrorAlert, Loading, Empty } from '../../components/ui';
import { RouteLine, PriceBlock } from '../../components/EmptyLegCard';
import PublicLayout from './PublicLayout';
import { normLeg, legWindow, flightTime, useDocumentTitle } from '../../lib/emptyLegs';
import { inr } from '../../lib/format';

export const TERMS_TEXT = 'Empty legs depend on the operator’s main charter and may be retimed or withdrawn; the booking is confirmed only when Meridian Charters confirms it.';
/** Terms for a flight posted by an independent lister: they confirm it and the customer pays them directly. */
export const termsFor = (leg) => (leg?.marketplace
  ? `This flight is listed and operated by ${leg.operated_by || 'an independent operator'}, not Meridian Charters. Empty legs may be retimed or withdrawn; the booking is confirmed only when the operator confirms it, and payment is arranged directly with them.`
  : TERMS_TEXT);

export default function EmptyLegPublicDetail() {
  const { id } = useParams();
  const [leg, setLeg] = useState(null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let live = true;
    publicApi.get(`/api/public/empty-legs/${encodeURIComponent(id)}`)
      .then(r => live && setLeg(normLeg(r.data)))
      .catch(e => { if (!live) return; if (e.response?.status === 404) setNotFound(true); else setError(errText(e)); });
    return () => { live = false; };
  }, [id]);

  useDocumentTitle(leg ? `${leg.from_city || leg.from_code} to ${leg.to_city || leg.to_code} empty leg · Meridian Charters` : 'Empty-leg flight · Meridian Charters');

  const w = leg ? legWindow(leg) : null;

  return (
    <PublicLayout>
      <main className="pub-main pub-detail">
        <Link to="/empty-legs" className="back">← All empty-leg flights</Link>
        <ErrorAlert error={error} />
        {notFound ? (
          <div className="card" style={{ marginTop: 16 }}>
            <Empty title="This flight is no longer available" action={<Link to="/empty-legs" className="btn btn-primary">See available flights</Link>}>
              It may have been booked or withdrawn. Other empty legs are listed on the deals page.
            </Empty>
          </div>
        ) : !leg ? (!error && <Loading label="Loading flight…" />) : (
          <div className="el-detail">
            <div className="el-detail-main">
              <div className="el-detail-hero">
                <div className="el-card-top">
                  <div>
                    <div className="el-date">{w.day}</div>
                    <div className="el-window light">Departure window {w.range} IST</div>
                  </div>
                  {leg.savings_pct > 0 && <span className="el-save">Save {leg.savings_pct}%</span>}
                </div>
                <RouteLine leg={leg} size="lg" />
                <div className="el-detail-price">
                  <PriceBlock leg={leg} align="left" />
                  <div className="ref">{leg.leg_no}</div>
                </div>
              </div>

              <div className="card card-pad">
                <h3 style={{ marginBottom: 12 }}>Flight details</h3>
                <dl className="dl">
                  <dt>From</dt><dd>{leg.from_city} ({leg.from_code}){leg.from_name ? ` · ${leg.from_name}` : ''}</dd>
                  <dt>To</dt><dd>{leg.to_city} ({leg.to_code}){leg.to_name ? ` · ${leg.to_name}` : ''}</dd>
                  <dt>Departure</dt><dd>{w.day}, between {w.range} IST</dd>
                  <dt>Aircraft</dt><dd>{leg.aircraft_type || 'Private jet'} · up to {leg.seats} passengers</dd>
                  <dt>Operated by</dt><dd>{leg.operated_by || 'Meridian Charters'}{leg.marketplace ? <span className="muted"> · independent listing</span> : null}</dd>
                  <dt>Flight time</dt><dd>{flightTime(leg.flight_hours)}</dd>
                  <dt>Price</dt><dd>{inr(leg.price_inr)} + GST for the whole aircraft</dd>
                  {leg.list_price_inr != null && <><dt>Normal charter</dt><dd><s className="muted">{inr(leg.list_price_inr)}</s></dd></>}
                </dl>
                <p className="small muted" style={{ marginTop: 16, marginBottom: 0 }}>
                  The exact departure time is fixed within the window once the main charter is finalised. {leg.marketplace ? 'The operator confirms' : 'We’ll confirm'} it with you directly.
                </p>
              </div>
            </div>

            <aside className="el-detail-side">
              {done ? <Success bookingNo={done} leg={leg} /> : <RequestForm leg={leg} onDone={setDone} />}
            </aside>
          </div>
        )}
      </main>
    </PublicLayout>
  );
}

function RequestForm({ leg, onDone }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', pax: '1', message: '', website: '' });
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const seats = Math.max(1, leg.seats || 1);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!terms) { setError('Please accept the empty-leg terms to continue.'); return; }
    setSaving(true);
    try {
      const r = await publicApi.post(`/api/public/empty-legs/${leg.id}/request`, {
        name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim(),
        company: f.company.trim() || undefined, pax: Number(f.pax),
        message: f.message.trim() || undefined, accept_terms: true, website: f.website,
      });
      onDone(r.data?.booking_no || r.data?.booking?.booking_no || 'received');
    } catch (err) {
      setError(err.response?.status === 429 ? 'Too many requests — please try again in an hour or call our charter desk.' : errText(err));
    } finally { setSaving(false); }
  };

  return (
    <form className="card el-form" onSubmit={submit}>
      <div className="card-head"><h2>Request this flight</h2></div>
      <div className="card-body">
        <p className="small muted" style={{ marginTop: 0 }}>No membership needed. Our charter desk replies within business hours.</p>
        <div className="form-grid">
          <div className="field span-2"><label htmlFor="r-name">Full name</label>
            <input id="r-name" className="input" required autoComplete="name" value={f.name} onChange={set('name')} /></div>
          <div className="field span-2"><label htmlFor="r-email">Email</label>
            <input id="r-email" className="input" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></div>
          <div className="field"><label htmlFor="r-phone">Phone</label>
            <input id="r-phone" className="input" type="tel" required autoComplete="tel" placeholder="+91 98xxx xxxxx" value={f.phone} onChange={set('phone')} /></div>
          <div className="field"><label htmlFor="r-pax">Passengers</label>
            <select id="r-pax" className="select" value={f.pax} onChange={set('pax')}>
              {Array.from({ length: seats }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </select></div>
          <div className="field span-2"><label htmlFor="r-company">Company <span className="muted">(optional)</span></label>
            <input id="r-company" className="input" autoComplete="organization" value={f.company} onChange={set('company')} /></div>
          <div className="field span-2"><label htmlFor="r-msg">Message <span className="muted">(optional)</span></label>
            <textarea id="r-msg" className="textarea" rows={3} placeholder="Anything we should know — timing preferences, luggage, pets…" value={f.message} onChange={set('message')} /></div>
        </div>
        {/* Honeypot: hidden from people and assistive tech; bots that fill it are silently ignored by the API. */}
        <div className="hp" aria-hidden="true">
          <label htmlFor="r-website">Website</label>
          <input id="r-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} />
        </div>
        <label className="check el-terms">
          <input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} required />
          <span>{termsFor(leg)}</span>
        </label>
        <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>
        <button className="btn btn-gold btn-block el-submit" disabled={saving}>
          {saving ? 'Sending request…' : `Request for ${inr(leg.price_inr)} + GST`}
        </button>
        <p className="xs muted" style={{ margin: '10px 0 0', textAlign: 'center' }}>You won’t be charged now. We confirm before invoicing.</p>
      </div>
    </form>
  );
}

function Success({ bookingNo, leg }) {
  return (
    <div className="card el-success" role="status">
      <div className="card-body">
        <div className="el-success-mark">✓</div>
        <div className="eyebrow">Request received</div>
        <h2 style={{ margin: '6px 0 8px' }}>Thank you — we’re on it.</h2>
        {bookingNo !== 'received' && <p className="small">Your reference is <strong className="mono">{bookingNo}</strong>.</p>}
        <h3 style={{ margin: '18px 0 8px', fontSize: '1.05rem' }}>What happens next</h3>
        {leg.marketplace ? (
          <ol className="el-next">
            <li>We’ve emailed you an acknowledgement with your reference.</li>
            <li>{leg.operated_by || 'The operator'} reviews your request and confirms by email.</li>
            <li>Once confirmed, you and the operator receive each other’s contact details to arrange payment, passenger details and the exact departure time.</li>
          </ol>
        ) : (
        <ol className="el-next">
          <li>We’ve emailed you an acknowledgement with your reference.</li>
          <li>Our charter desk checks the flight against the main charter and confirms by email — usually within a few hours.</li>
          <li>Once confirmed you receive the GST invoice ({inr(leg.price_inr)} + GST) and a link to set up your Meridian account, where you add passenger details.</li>
          <li>Pay from your account by bank transfer, card, UPI or netbanking. Payment is due 24 hours before departure — if the flight leaves sooner, within 2 hours of confirmation.</li>
        </ol>
        )}
        <Link to="/empty-legs" className="btn btn-block" style={{ marginTop: 16 }}>Browse more flights</Link>
      </div>
    </div>
  );
}
