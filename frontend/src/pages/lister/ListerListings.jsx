import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, Modal, Toast } from '../../components/ui';
import CancelModal from '../../components/CancelModal';
import { normLeg, legRoute, legWindow, flightTime } from '../../lib/emptyLegs';
import { inr, toIstInput, istInputToIso } from '../../lib/format';

/** Account status banner shared by the lister pages. */
export function ListerStatusBanner({ me }) {
  if (!me) return null;
  if (me.status === 'pending') {
    return (
      <div className="alert alert-warn">
        <strong>We’re verifying your account.</strong> This usually takes one working day. You can prepare draft listings now —
        publish them as soon as you’re approved.
      </div>
    );
  }
  if (me.status === 'rejected') {
    return (
      <div className="alert alert-error">
        <strong>We couldn’t approve your account{me.decision_reason ? `: ${me.decision_reason}` : '.'}</strong>{' '}
        <Link to="/l/profile">Update your details</Link> and we’ll review them again.
      </div>
    );
  }
  if (me.status === 'suspended') {
    return (
      <div className="alert alert-error">
        <strong>Your account is suspended{me.decision_reason ? `: ${me.decision_reason}` : '.'}</strong> Your listings have been taken down.
        Contact us if you think this is a mistake.
      </div>
    );
  }
  return null;
}

export default function ListerListings() {
  const [params] = useSearchParams();
  const me = useFetch('/api/lister/me');
  const { data, error, loading, reload } = useFetch('/api/lister/empty-legs');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState('');
  const [withdrawing, setWithdrawing] = useState(null);
  const [busy, setBusy] = useState('');
  const [actErr, setActErr] = useState('');
  const [toast, setToast] = useState('');
  const list = useMemo(() => (Array.isArray(data) ? data : []).map(normLeg), [data]);
  const status = me.data?.status;
  const canPublish = status === 'approved';
  const canCreate = status && status !== 'suspended';
  const live = list.filter(l => l.status === 'published').length;
  const pending = list.reduce((n, l) => n + (l.requests_count || 0), 0);

  const publish = async (l) => {
    setBusy(l.id); setActErr('');
    try { await api.post(`/api/lister/empty-legs/${l.id}/publish`); setToast(`${l.leg_no} is live`); reload(); }
    catch (e) { setActErr(errText(e)); } finally { setBusy(''); }
  };

  const newBtn = canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}>Post an empty leg</button>;

  return (
    <>
      <PageHead eyebrow={me.data?.company || 'Lister'} title="My empty legs"
        sub="Flights you list appear on the public empty-leg deals page. You confirm every booking request."
        actions={newBtn} />
      {params.get('welcome') && status === 'pending' && (
        <div className="alert alert-ok">Welcome aboard — your account is created. We’ve emailed you a confirmation.</div>
      )}
      <ListerStatusBanner me={me.data} />
      {list.length > 0 && (
        <div className="stats">
          <div className="stat"><div className="label">Live now</div><div className="value">{live}</div></div>
          <Link to="/l/requests" className="stat"><div className="label">Requests to answer</div><div className="value">{pending}</div></Link>
          <div className="stat"><div className="label">Booked</div><div className="value">{list.filter(l => l.status === 'booked').length}</div></div>
        </div>
      )}
      <ErrorAlert error={error || me.error || actErr} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No listings yet" action={newBtn}>
          Post a one-way or positioning flight with its departure window and price. Travellers send you booking requests.
        </Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table el-table">
            <thead><tr>
              <th>Listing</th><th>Route</th><th>Window (IST)</th><th>Aircraft</th><th className="num">Price</th><th>Status</th><th />
            </tr></thead>
            <tbody>
              {list.map(l => {
                const w = legWindow(l);
                const editable = ['draft', 'published'].includes(l.status) && status !== 'suspended';
                return (
                  <Fragment key={l.id}>
                    <tr className={editing === l.id ? 'editing' : ''}>
                      <td className="nowrap"><span className="strong">{l.leg_no}</span>
                        {l.status === 'withdrawn' && l.withdrawn_reason && <div className="muted xs">{l.withdrawn_reason}</div>}</td>
                      <td className="nowrap"><strong>{legRoute(l)}</strong><div className="muted xs">{l.from_city} → {l.to_city} · {flightTime(l.flight_hours)}</div></td>
                      <td className="nowrap">{w.day}<div className="muted xs">{w.range}</div></td>
                      <td className="nowrap">{l.aircraft_type}<div className="muted xs">{[l.registration, `${l.seats} seats`].filter(Boolean).join(' · ')}</div></td>
                      <td className="num nowrap"><strong>{inr(l.price_inr)}</strong>
                        {l.savings_pct > 0 && <div className="muted xs"><s>{inr(l.list_price_inr)}</s> · {l.savings_pct}% off</div>}</td>
                      <td className="nowrap"><StatusPill status={l.status} />
                        {l.requests_count > 0 && <div className="xs" style={{ marginTop: 4 }}>
                          <Link to="/l/requests" style={{ color: 'var(--amber-fg)', fontWeight: 700 }}>{l.requests_count} request{l.requests_count > 1 ? 's' : ''}</Link></div>}</td>
                      <td className="right nowrap">
                        <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          {l.status === 'draft' && (
                            <button className="btn btn-sm btn-gold" disabled={!canPublish || busy === l.id} onClick={() => publish(l)}
                              title={canPublish ? '' : 'You can publish once your account is approved'}>
                              {busy === l.id ? 'Publishing…' : 'Publish'}
                            </button>
                          )}
                          {editable && <button className="btn btn-sm" onClick={() => setEditing(editing === l.id ? '' : l.id)}>{editing === l.id ? 'Close' : 'Edit'}</button>}
                          {editable && <button className="btn btn-sm btn-danger" onClick={() => setWithdrawing(l)}>Withdraw</button>}
                        </div>
                      </td>
                    </tr>
                    {editing === l.id && (
                      <tr className="edit-row"><td colSpan={7}>
                        <EditListing leg={l} onCancel={() => setEditing('')} onSaved={() => { setEditing(''); setToast(`${l.leg_no} updated`); reload(); }} />
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewListingModal company={me.data?.company} approved={canPublish}
        onClose={() => setCreating(false)}
        onDone={(l) => { setCreating(false); setToast(`${l?.leg_no || 'Listing'} saved as draft`); reload(); }} />}
      {withdrawing && (
        <CancelModal title={`Withdraw ${withdrawing.leg_no}`} confirmLabel="Withdraw listing" path={`/api/lister/empty-legs/${withdrawing.id}/withdraw`}
          requireReason={false}
          warning="The flight is removed from the deals page. Anyone with a pending request is told the flight was withdrawn."
          onClose={() => setWithdrawing(null)} onDone={() => { setWithdrawing(null); setToast('Listing withdrawn'); reload(); }} />
      )}
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function EditListing({ leg, onCancel, onSaved }) {
  const [f, setF] = useState({
    price_inr: leg.price_inr ?? '',
    list_price_inr: leg.list_price_inr > leg.price_inr ? leg.list_price_inr : '',
    depart_earliest: toIstInput(leg.depart_earliest),
    depart_latest: toIstInput(leg.depart_latest),
    seats: leg.seats ?? '',
    notes: leg.notes || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    if (f.depart_latest < f.depart_earliest) { setError('Window end must be after its start.'); return; }
    setSaving(true); setError('');
    try {
      await api.patch(`/api/lister/empty-legs/${leg.id}`, {
        price_inr: Number(f.price_inr),
        list_price_inr: f.list_price_inr === '' ? null : Number(f.list_price_inr),
        depart_earliest: istInputToIso(f.depart_earliest),
        depart_latest: istInputToIso(f.depart_latest),
        seats: Number(f.seats),
        notes: f.notes,
      });
      onSaved();
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };

  return (
    <form className="el-edit" onSubmit={save}>
      <div className="el-edit-grid">
        <div className="field"><label>Price excl. GST (₹)</label>
          <input className="input" type="number" min="1" step="1" required value={f.price_inr} onChange={set('price_inr')} /></div>
        <div className="field"><label>Usual charter price (₹)</label>
          <input className="input" type="number" min="1" step="1" value={f.list_price_inr} onChange={set('list_price_inr')} placeholder="Optional" /></div>
        <div className="field"><label>Window start (IST)</label>
          <input className="input" type="datetime-local" required value={f.depart_earliest} onChange={set('depart_earliest')} /></div>
        <div className="field"><label>Window end (IST)</label>
          <input className="input" type="datetime-local" required value={f.depart_latest} onChange={set('depart_latest')} /></div>
        <div className="field"><label>Seats</label>
          <input className="input" type="number" min="1" max="30" required value={f.seats} onChange={set('seats')} /></div>
        <div className="field el-edit-notes"><label>Notes for travellers</label>
          <input className="input" value={f.notes} onChange={set('notes')} placeholder="Optional" /></div>
      </div>
      <div style={{ marginTop: 10 }}><ErrorAlert error={error} /></div>
      <div className="actions" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
  );
}

function NewListingModal({ company, approved, onClose, onDone }) {
  const { data: airports } = useFetch('/api/lister/airports');
  const [f, setF] = useState({
    from_code: '', to_code: '', depart_earliest: '', depart_latest: '', aircraft_type: '', registration: '', operator_name: company || '',
    seats: '', flight_hours: '', price_inr: '', list_price_inr: '', notes: '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [publishNow, setPublishNow] = useState(approved);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const aps = Array.isArray(airports) ? airports : [];
  const pct = f.list_price_inr && f.price_inr && Number(f.list_price_inr) > Number(f.price_inr)
    ? Math.round((1 - Number(f.price_inr) / Number(f.list_price_inr)) * 100) : null;

  const submit = async (e) => {
    e.preventDefault();
    if (f.from_code === f.to_code) { setError('From and to must be different airports.'); return; }
    if (f.depart_latest && f.depart_latest < f.depart_earliest) { setError('Window end must be after its start.'); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post('/api/lister/empty-legs', {
        from_code: f.from_code, to_code: f.to_code,
        depart_earliest: istInputToIso(f.depart_earliest), depart_latest: istInputToIso(f.depart_latest || f.depart_earliest),
        aircraft_type: f.aircraft_type, registration: f.registration, operator_name: f.operator_name,
        seats: Number(f.seats), flight_hours: f.flight_hours === '' ? undefined : Number(f.flight_hours),
        price_inr: Number(f.price_inr), list_price_inr: f.list_price_inr === '' ? undefined : Number(f.list_price_inr),
        notes: f.notes.trim() || undefined,
      });
      if (publishNow && approved) {
        try { await api.post(`/api/lister/empty-legs/${r.data.id}/publish`); }
        catch (err) { setError(`Saved as draft, but not published: ${errText(err)}`); setSaving(false); return; }
      }
      onDone(normLeg(r.data));
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };

  return (
    <Modal title="Post an empty leg" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field"><label htmlFor="n-from">From</label>
            <select id="n-from" className="select" required value={f.from_code} onChange={set('from_code')}>
              <option value="">Select airport</option>
              {aps.map(a => <option key={a.code} value={a.code}>{a.city} ({a.code})</option>)}
            </select></div>
          <div className="field"><label htmlFor="n-to">To</label>
            <select id="n-to" className="select" required value={f.to_code} onChange={set('to_code')}>
              <option value="">Select airport</option>
              {aps.map(a => <option key={a.code} value={a.code} disabled={a.code === f.from_code}>{a.city} ({a.code})</option>)}
            </select></div>
          <div className="field"><label htmlFor="n-e">Earliest departure (IST)</label>
            <input id="n-e" className="input" type="datetime-local" required value={f.depart_earliest} onChange={set('depart_earliest')} /></div>
          <div className="field"><label htmlFor="n-l">Latest departure (IST)</label>
            <input id="n-l" className="input" type="datetime-local" min={f.depart_earliest || undefined} value={f.depart_latest} onChange={set('depart_latest')} />
            <span className="hint">A window of up to 24 hours. Leave blank for a fixed time.</span></div>
          <div className="field"><label htmlFor="n-ac">Aircraft type</label>
            <input id="n-ac" className="input" required value={f.aircraft_type} onChange={set('aircraft_type')} placeholder="e.g. Citation XLS" /></div>
          <div className="field"><label htmlFor="n-seats">Passenger seats</label>
            <input id="n-seats" className="input" type="number" min="1" max="30" required value={f.seats} onChange={set('seats')} /></div>
          <div className="field"><label htmlFor="n-reg">Registration <span className="muted">— optional, never shown publicly</span></label>
            <input id="n-reg" className="input" value={f.registration} onChange={set('registration')} placeholder="VT-…" style={{ textTransform: 'uppercase' }} /></div>
          <div className="field"><label htmlFor="n-op">Operated by</label>
            <input id="n-op" className="input" value={f.operator_name} onChange={set('operator_name')} placeholder="Operator shown to travellers" />
            <span className="hint">Agents and flyers: the licensed operator flying the aircraft.</span></div>
          <div className="field"><label htmlFor="n-price">Your price excl. GST (₹)</label>
            <input id="n-price" className="input" type="number" min="1" step="1" required value={f.price_inr} onChange={set('price_inr')} />
            <span className="hint">For the whole aircraft.</span></div>
          <div className="field"><label htmlFor="n-list">Usual charter price (₹) <span className="muted">— optional</span></label>
            <input id="n-list" className="input" type="number" min="1" step="1" value={f.list_price_inr} onChange={set('list_price_inr')} />
            <span className="hint">{pct != null ? `Shown as ${pct}% off.` : 'Shown struck through to highlight the saving.'}</span></div>
          <div className="field"><label htmlFor="n-hrs">Flight time (hours) <span className="muted">— optional</span></label>
            <input id="n-hrs" className="input" type="number" min="0.2" max="12" step="0.1" value={f.flight_hours} onChange={set('flight_hours')} placeholder="Estimated from distance" /></div>
          <div className="field"><label htmlFor="n-notes">Notes for travellers <span className="muted">— optional</span></label>
            <input id="n-notes" className="input" value={f.notes} onChange={set('notes')} placeholder="e.g. Baggage limit 15 kg per person" /></div>
        </div>
        {approved
          ? <label className="check" style={{ marginTop: 14 }}><input type="checkbox" checked={publishNow} onChange={e => setPublishNow(e.target.checked)} /> Publish straight away</label>
          : <p className="hint" style={{ marginTop: 14 }}>Saved as a draft. You can publish it once your account is approved.</p>}
        <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : publishNow && approved ? 'Publish listing' : 'Save draft'}</button>
        </div>
      </form>
    </Modal>
  );
}

