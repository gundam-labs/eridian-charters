import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api, { errText } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, Modal, CopyField, Toast } from '../../components/ui';
import CancelModal from '../../components/CancelModal';
import { normLeg, normBooking, legRoute, legWindow, flightTime } from '../../lib/emptyLegs';
import { inr, fmtDateTime, toIstInput, istInputToIso, humanize } from '../../lib/format';

export default function EmptyLegsAdmin() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = ['requests', 'demand'].includes(params.get('tab')) ? params.get('tab') : 'listings';
  const canDecide = ['sales', 'admin'].includes(user.role);
  const pending = useFetch('/api/empty-legs/bookings?status=requested');
  const pendingCount = Array.isArray(pending.data) ? pending.data.length : 0;
  const setTab = (t) => setParams(t !== 'listings' ? { tab: t } : {}, { replace: true });

  return (
    <>
      <PageHead eyebrow={user.role === 'ops' ? 'Operations' : 'Sales'} title="Empty legs"
        sub="Positioning flights sold as whole-aircraft charters to members and the public."
        actions={<a href="/empty-legs" target="_blank" rel="noreferrer" className="btn">Public page ↗</a>} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'listings'} className={tab === 'listings' ? 'on' : ''} onClick={() => setTab('listings')}>Listings</button>
        <button role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>
          Requests {pendingCount > 0 && <span className="tab-count">{pendingCount}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'demand'} className={tab === 'demand' ? 'on' : ''} onClick={() => setTab('demand')}>Demand</button>
      </div>
      {tab === 'listings' ? <Listings /> : tab === 'demand' ? <Demand /> : <Requests canDecide={canDecide} onChanged={pending.reload} />}
    </>
  );
}

/* ───────────────────────── Listings ───────────────────────── */

function Listings() {
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const qs = new URLSearchParams(Object.entries({ status, source }).filter(([, v]) => v)).toString();
  const { data, error, loading, reload } = useFetch(`/api/empty-legs${qs ? `?${qs}` : ''}`);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState('');
  const [withdrawing, setWithdrawing] = useState(null);
  const [busy, setBusy] = useState('');
  const [actErr, setActErr] = useState('');
  const [toast, setToast] = useState('');
  const list = useMemo(() => (Array.isArray(data) ? data : []).map(normLeg)
    .sort((a, b) => new Date(a.depart_earliest) - new Date(b.depart_earliest)), [data]);

  const publish = async (l) => {
    setBusy(l.id); setActErr('');
    try { await api.post(`/api/empty-legs/${l.id}/publish`); setToast(`${l.leg_no} published`); reload(); }
    catch (e) { setActErr(errText(e)); } finally { setBusy(''); }
  };

  return (
    <>
      <div className="filters">
        <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {['draft', 'published', 'booked', 'withdrawn', 'expired'].map(s => <option key={s} value={s}>{humanize(s)}</option>)}
        </select>
        <select className="select" value={source} onChange={e => setSource(e.target.value)} aria-label="Source">
          <option value="">Fleet and listers</option>
          <option value="fleet">Meridian fleet</option>
          <option value="listers">Independent listers</option>
        </select>
        <span style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setCreating(true)}>New empty leg</button>
      </div>
      <ErrorAlert error={error || actErr} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No empty legs" action={<button className="btn btn-primary" onClick={() => setCreating(true)}>New empty leg</button>}>
          Empty legs are generated when a charter with positioning flights is confirmed, or you can add one manually.
        </Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table el-table">
            <thead><tr>
              <th>Leg</th><th>Route</th><th>Window (IST)</th><th>Aircraft</th><th className="num">Price · list</th><th>Status</th><th />
            </tr></thead>
            <tbody>
              {list.map(l => {
                const w = legWindow(l);
                const lister = Boolean(l.lister_id);
                const editable = ['draft', 'published'].includes(l.status) && !lister;
                const withdrawable = ['draft', 'published'].includes(l.status);
                return (
                  <Fragment key={l.id}>
                    <tr className={editing === l.id ? 'editing' : ''}>
                      <td className="nowrap"><span className="strong">{l.leg_no}</span>
                        <div className="xs">{lister
                          ? <><Link to="/s/listers">Listed by {l.lister_company || l.lister_name}</Link>
                            {l.dgca_check && <div className={`dgca-badge ${l.dgca_check}`}>{l.dgca_check === 'own_fleet' ? '✓ DGCA: own fleet' : l.dgca_check === 'other_operator' ? `DGCA: ${l.dgca_operator_name}` : 'Not in DGCA list'}</div>}</>
                          : l.source_charter_id
                            ? <Link to={`/o/charters/${l.source_charter_id}`}>from {l.source_charter_no || 'charter'}</Link>
                            : <span className="muted">Manual</span>}</div></td>
                      <td className="nowrap"><strong>{legRoute(l)}</strong><div className="muted xs">{flightTime(l.flight_hours)}</div></td>
                      <td className="nowrap">{w.day}<div className="muted xs">{w.range}</div></td>
                      <td className="nowrap">{l.registration || '—'}<div className="muted xs">{l.seats} seats</div></td>
                      <td className="num nowrap"><strong>{inr(l.price_inr)}</strong>
                        <div className="muted xs"><s>{inr(l.list_price_inr)}</s>{l.savings_pct != null ? ` · ${l.savings_pct}% off` : ''}</div></td>
                      <td className="nowrap"><StatusPill status={l.status} />
                        <div className="xs" style={{ marginTop: 4 }}>{l.requests_count > 0
                          ? <Link to="?tab=requests" style={{ color: 'var(--amber-fg)', fontWeight: 700 }}>{l.requests_count} pending request{l.requests_count > 1 ? 's' : ''}</Link>
                          : <span className="muted">{l.bookings_count ? `${l.bookings_count} booking${l.bookings_count > 1 ? 's' : ''}` : 'No requests'}</span>}</div></td>
                      <td className="right nowrap">
                        <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          {l.status === 'draft' && !lister && <button className="btn btn-sm btn-gold" disabled={busy === l.id} onClick={() => publish(l)}>{busy === l.id ? 'Publishing…' : 'Publish'}</button>}
                          {editable && <button className="btn btn-sm" onClick={() => setEditing(editing === l.id ? '' : l.id)}>{editing === l.id ? 'Close' : 'Edit'}</button>}
                          {withdrawable && <button className="btn btn-sm btn-danger" onClick={() => setWithdrawing(l)}>Withdraw</button>}
                        </div>
                      </td>
                    </tr>
                    {editing === l.id && (
                      <tr className="edit-row"><td colSpan={7}>
                        <EditLeg leg={l} onCancel={() => setEditing('')} onSaved={() => { setEditing(''); setToast(`${l.leg_no} updated`); reload(); }} />
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewLegModal onClose={() => setCreating(false)} onDone={(l) => { setCreating(false); setToast(`${l?.leg_no || 'Empty leg'} created as draft`); reload(); }} />}
      {withdrawing && (
        <CancelModal title={`Withdraw ${withdrawing.leg_no}`} confirmLabel="Withdraw" path={`/api/empty-legs/${withdrawing.id}/withdraw`}
          warning={withdrawing.lister_id
            ? `The flight is removed from the public page and pending requests are cancelled. ${withdrawing.lister_company || 'The lister'} is emailed your reason.`
            : 'The flight is removed from the public page and the member list. Pending requests on it should be rejected.'}
          onClose={() => setWithdrawing(null)} onDone={() => { setWithdrawing(null); setToast('Empty leg withdrawn'); reload(); }} />
      )}
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function EditLeg({ leg, onCancel, onSaved }) {
  const [f, setF] = useState({
    price_inr: leg.price_inr ?? '',
    depart_earliest: toIstInput(leg.depart_earliest),
    depart_latest: toIstInput(leg.depart_latest),
    notes: leg.notes || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const pct = leg.list_price_inr && f.price_inr !== '' ? Math.round((1 - Number(f.price_inr) / leg.list_price_inr) * 100) : null;

  const save = async (e) => {
    e.preventDefault();
    if (f.depart_latest && f.depart_earliest && f.depart_latest < f.depart_earliest) { setError('Window end must be after its start.'); return; }
    setSaving(true); setError('');
    try {
      await api.patch(`/api/empty-legs/${leg.id}`, {
        price_inr: f.price_inr === '' ? undefined : Number(f.price_inr),
        depart_earliest: istInputToIso(f.depart_earliest),
        depart_latest: istInputToIso(f.depart_latest),
        notes: f.notes,
      });
      onSaved();
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };

  return (
    <form className="el-edit" onSubmit={save}>
      <div className="el-edit-grid">
        <div className="field"><label>Price excl. GST (₹)</label>
          <input className="input" type="number" min="0" step="1000" value={f.price_inr} onChange={set('price_inr')} />
          <span className="hint">List {inr(leg.list_price_inr)}{pct != null ? ` · ${pct}% off` : ''}</span></div>
        <div className="field"><label>Window start (IST)</label>
          <input className="input" type="datetime-local" required value={f.depart_earliest} onChange={set('depart_earliest')} /></div>
        <div className="field"><label>Window end (IST)</label>
          <input className="input" type="datetime-local" required value={f.depart_latest} onChange={set('depart_latest')} /></div>
        <div className="field el-edit-notes"><label>Notes</label>
          <input className="input" value={f.notes} onChange={set('notes')} placeholder="Internal notes" /></div>
      </div>
      {leg.source_charter_id && <p className="hint" style={{ margin: '8px 0 0' }}>Window changes are limited so the flight never overlaps the source charter’s passenger legs.</p>}
      <div style={{ marginTop: 10 }}><ErrorAlert error={error} /></div>
      <div className="actions" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
  );
}

function NewLegModal({ onClose, onDone }) {
  const { data: aircraft } = useFetch('/api/aircraft');
  const { data: airports } = useFetch('/api/airports');
  const [f, setF] = useState({ aircraft_id: '', from_code: '', to_code: '', depart_earliest: '', depart_latest: '', price_inr: '', notes: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const ac = (aircraft || []).find(a => a.id === f.aircraft_id);
  const aps = (airports || []).slice().sort((a, b) => String(a.city).localeCompare(String(b.city)));

  const pickAircraft = (e) => {
    const a = (aircraft || []).find(x => x.id === e.target.value);
    setF(s => ({ ...s, aircraft_id: e.target.value, from_code: s.from_code || a?.home_base || '' }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (f.from_code === f.to_code) { setError('From and to must be different airports.'); return; }
    if (f.depart_latest < f.depart_earliest) { setError('Window end must be after its start.'); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post('/api/empty-legs', {
        aircraft_id: f.aircraft_id, from_code: f.from_code, to_code: f.to_code,
        depart_earliest: istInputToIso(f.depart_earliest), depart_latest: istInputToIso(f.depart_latest),
        price_inr: f.price_inr === '' ? undefined : Number(f.price_inr),
        notes: f.notes.trim() || undefined,
      });
      onDone(normLeg(r.data));
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };

  return (
    <Modal title="New empty leg" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field span-2"><label>Aircraft</label>
            <select className="select" required value={f.aircraft_id} onChange={pickAircraft}>
              <option value="">Select aircraft</option>
              {(aircraft || []).filter(a => a.status !== 'inactive').map(a => <option key={a.id} value={a.id}>{a.registration} · {a.type} · {a.seats} seats · base {a.home_base}</option>)}
            </select></div>
          <div className="field"><label>From</label>
            <select className="select" required value={f.from_code} onChange={set('from_code')}>
              <option value="">Select airport</option>
              {aps.map(a => <option key={a.code} value={a.code}>{a.city} ({a.code})</option>)}
            </select></div>
          <div className="field"><label>To</label>
            <select className="select" required value={f.to_code} onChange={set('to_code')}>
              <option value="">Select airport</option>
              {aps.map(a => <option key={a.code} value={a.code} disabled={a.code === f.from_code}>{a.city} ({a.code})</option>)}
            </select></div>
          <div className="field"><label>Window start (IST)</label>
            <input className="input" type="datetime-local" required value={f.depart_earliest} onChange={set('depart_earliest')} /></div>
          <div className="field"><label>Window end (IST)</label>
            <input className="input" type="datetime-local" required min={f.depart_earliest || undefined} value={f.depart_latest} onChange={set('depart_latest')} /></div>
          <div className="field"><label>Price excl. GST (₹) <span className="muted">— optional</span></label>
            <input className="input" type="number" min="0" step="1000" value={f.price_inr} onChange={set('price_inr')} placeholder="Default discount" />
            <span className="hint">Leave blank to apply the default empty-leg discount to the list price.</span></div>
          <div className="field"><label>Notes</label>
            <input className="input" value={f.notes} onChange={set('notes')} placeholder="Optional" /></div>
        </div>
        {ac && <p className="hint" style={{ marginTop: 10 }}>{ac.type} · {ac.seats} seats. The list price is computed from flight time, landing and handling fees.</p>}
        <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create draft'}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────────────── Requests ───────────────────────── */

function Requests({ canDecide, onChanged }) {
  const [status, setStatus] = useState('requested');
  const { data, error, loading, reload } = useFetch(`/api/empty-legs/bookings${status ? `?status=${status}` : ''}`);
  const [confirming, setConfirming] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const list = (Array.isArray(data) ? data : []).map(normBooking)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const refresh = () => { reload(); onChanged?.(); };

  return (
    <>
      <div className="filters">
        <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">All requests</option>
          {['requested', 'confirmed', 'rejected', 'cancelled'].map(s => <option key={s} value={s}>{humanize(s)}</option>)}
        </select>
        {!canDecide && <span className="muted small">Read only — sales confirms or rejects requests.</span>}
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title={status === 'requested' ? 'No pending requests' : 'No requests'}>
          Booking requests from the public page and member bookings appear here.
        </Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table el-table">
            <thead><tr>
              <th>Booking</th><th>Flight</th><th>Customer</th><th className="num">Pax</th><th>Status</th>{canDecide && <th />}
            </tr></thead>
            <tbody>
              {list.map(b => {
                const w = legWindow(b.leg);
                return (
                  <tr key={b.id}>
                    <td className="nowrap"><span className="strong">{b.booking_no}</span>
                      <div style={{ marginTop: 4 }}><span className={`pill ${b.channel === 'member' ? 'pill-gold' : 'pill-blue'}`}>{b.channel === 'member' ? 'Member' : 'Public'}</span>
                        {b.marketplace && <span className="pill pill-violet" style={{ marginLeft: 4 }}>Lister</span>}</div>
                      <div className="muted xs" style={{ marginTop: 4 }}>{fmtDateTime(b.created_at)}</div>
                      {b.charter_id && <div className="xs"><Link to={`/o/charters/${b.charter_id}`}>View charter</Link></div>}</td>
                    <td className="nowrap"><strong>{legRoute(b.leg)}</strong> <span className="muted xs">{b.leg.leg_no}</span>
                      <div className="muted xs">{w.day} · {w.range}{b.leg.price_inr != null ? ` · ${inr(b.leg.price_inr)}` : ''}</div></td>
                    <td>
                      <div className="strong">{b.customer}{b.company ? <span className="muted"> · {b.company}</span> : null}</div>
                      <div className="muted xs">{[b.email, b.phone].filter(Boolean).join(' · ')}</div>
                      {b.message && <div className="xs el-msg">“{b.message}”</div>}
                      {b.reject_reason && <div className="xs" style={{ color: 'var(--red-fg)' }}>{b.reject_reason}</div>}
                      {b.pay_status && <div className="xs" style={{ marginTop: 4 }}><span className="strong">{{ authorized: 'Payment held', captured: 'Paid', released: 'Hold released', refunded: 'Refunded', partially_refunded: 'Part refunded' }[b.pay_status] || b.pay_status}</span> · {inr(b.pay_amount)}</div>}
                    </td>
                    <td className="num">{b.pax}</td>
                    <td><StatusPill status={b.status} /></td>
                    {canDecide && (
                      <td className="right nowrap">
                        {b.status === 'requested' && b.marketplace && (
                          <div>
                            <div className="muted xs">{b.leg.operator_name || b.leg.lister_company || 'The lister'} decides</div>
                            <button className="btn btn-sm btn-danger" style={{ marginTop: 4 }} onClick={() => setRejecting(b)}>Reject</button>
                          </div>
                        )}
                        {b.status === 'requested' && !b.marketplace && (
                          <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                            <button className="btn btn-sm btn-gold" onClick={() => setConfirming(b)}>Confirm</button>
                            <button className="btn btn-sm btn-danger" onClick={() => setRejecting(b)}>Reject</button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirming && <ConfirmModal booking={confirming} onClose={() => setConfirming(null)} onChanged={refresh} />}
      {rejecting && (
        <CancelModal title={`Reject ${rejecting.booking_no}`} confirmLabel="Reject request" path={`/api/empty-legs/bookings/${rejecting.id}/reject`}
          warning={`${rejecting.customer} is emailed that the flight could not be confirmed, with your reason.`}
          onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); refresh(); }} />
      )}
    </>
  );
}

function ConfirmModal({ booking: b, onClose, onChanged }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isPublic = b.channel !== 'member';

  const confirm = async () => {
    setSaving(true); setError('');
    try {
      const r = await api.post(`/api/empty-legs/bookings/${b.id}/confirm`);
      setResult(r.data || {});
      onChanged();
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };

  const charter = result?.charter;
  const member = result?.member;
  const invoice = result?.invoice;
  return (
    <Modal title={result ? 'Booking confirmed' : `Confirm ${b.booking_no}`} onClose={onClose}>
      {!result ? (
        <>
          <dl className="dl">
            <dt>Flight</dt><dd>{legRoute(b.leg)} · {b.leg.leg_no}</dd>
            <dt>Departure</dt><dd>{legWindow(b.leg).day}, {legWindow(b.leg).range} IST</dd>
            <dt>Customer</dt><dd>{b.customer}{b.company ? ` · ${b.company}` : ''}</dd>
            <dt>Email</dt><dd>{b.email || '—'}</dd>
            <dt>Passengers</dt><dd>{b.pax}</dd>
            <dt>Price</dt><dd>{inr(b.leg.price_inr)} + GST</dd>
          </dl>
          <div className="alert alert-info" style={{ marginTop: 16 }}>
            Confirming creates the charter and GST invoice, marks the leg booked and rejects other pending requests on it.
            {isPublic && ' The customer is matched to an existing member by email or onboarded as a new member, and emailed an invite to set their password.'}
          </div>
          <ErrorAlert error={error} />
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>Back</button>
            <button className="btn btn-gold" disabled={saving} onClick={confirm}>{saving ? 'Confirming…' : 'Confirm booking'}</button>
          </div>
        </>
      ) : (
        <>
          <div className="alert alert-ok">
            {charter?.charter_no || 'Charter'} created{invoice?.invoice_no ? ` with invoice ${invoice.invoice_no}` : ''}.
            {member?.member_no ? ` Member ${member.member_no}.` : ''} Confirmation emailed to {b.email || 'the customer'}.
            {' '}Payment is due 24 hours before departure — within 2 hours for late bookings — or the flight is released.
          </div>
          {result.invite_url && (
            <div className="field" style={{ marginTop: 6 }}>
              <label>Invite link (valid 72h)</label>
              <CopyField value={result.invite_url} />
              <span className="hint">Also emailed — share it directly if the customer can’t find the email.</span>
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>Close</button>
            {(charter?.id || result.charter_id) && <Link className="btn btn-primary" to={`/o/charters/${charter?.id || result.charter_id}`}>Open charter</Link>}
          </div>
        </>
      )}
    </Modal>
  );
}

/* ───────────────────────── Demand (route alerts) ───────────────────────── */

function Demand() {
  const { data, error, loading } = useFetch('/api/marketplace/route-demand');
  const rows = Array.isArray(data) ? data : [];
  const total = rows.reduce((n, r) => n + r.travellers, 0);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>Routes travellers asked to be alerted about on the public deals page. {total > 0 && <strong>{total} traveller{total === 1 ? '' : 's'} waiting.</strong>} Routes with no live flight are the ones to fill.</p>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : rows.length === 0 ? (
        <div className="card"><Empty title="No route alerts yet">Travellers can save a route on the public deals page.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Route</th><th className="num">Travellers</th><th className="num">Live flights</th><th>Latest alert</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.from_code}-${r.to_code}`}>
                  <td className="strong">{r.from_city ? `${r.from_city} (${r.from_code})` : 'Anywhere'} → {r.to_city ? `${r.to_city} (${r.to_code})` : 'Anywhere'}</td>
                  <td className="num">{r.travellers}</td>
                  <td className="num">{r.live_matches > 0 ? r.live_matches : <span className="pill pill-amber">None</span>}</td>
                  <td className="nowrap muted small">{fmtDateTime(r.latest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
