import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api, { errText, openPdf } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { normCharter, crewName } from '../../lib/normalize';
import { PageHead, ErrorAlert, Loading, StatusPill, OkAlert } from '../../components/ui';
import Timeline from '../../components/Timeline';
import LegsTable from '../../components/LegsTable';
import ManifestEditor from '../../components/ManifestEditor';
import FlightLogForm from '../../components/FlightLogForm';
import CancelModal from '../../components/CancelModal';
import PaymentCard from '../../components/PaymentCard';
import { charterPaymentStatus } from '../../lib/payments';
import { fmtDate, fmtDateTime, inr, route, memberName, aircraftReg, aircraftType, humanize } from '../../lib/format';
import { normLeg, legRoute, legWindow, emptyLegsPath } from '../../lib/emptyLegs';

const EDITABLE = ['accepted', 'confirmed', 'manifest_complete'];

export default function CharterDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const isOps = ['ops', 'admin'].includes(user.role);
  const { data, error, loading, reload } = useFetch(`/api/charters/${id}`);
  const c = normCharter(data);
  const [ok, setOk] = useState('');
  const [actErr, setActErr] = useState('');
  const [busy, setBusy] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const confirm = async () => {
    setBusy('confirm'); setActErr(''); setOk('');
    try { await api.post(`/api/charters/${id}/confirm`); setOk('Charter confirmed — member has been emailed.'); reload(); }
    catch (e) { setActErr(errText(e)); } finally { setBusy(''); }
  };

  if (loading && !c) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  if (!c) return null;

  const hasCrew = !!(c.captain_id && c.first_officer_id);
  const inv = c.invoice;
  const derived = c.empty_leg || data?.empty_leg || (c.empty_leg_no ? { leg_no: c.empty_leg_no } : null);
  const emptyLegs = c.empty_legs || data?.empty_legs;
  const payStatus = charterPaymentStatus(c);
  const awaitingPayment = !!payStatus && payStatus !== 'paid';

  return (
    <>
      <PageHead back={<Link to="/o/charters" className="back">← Charters</Link>}
        eyebrow={<>{c.charter_no}{derived && <span className="el-badge" title="This charter was sold from an empty leg">Empty-leg booking {derived.leg_no || ''}</span>}</>}
        title={route(c.legs)}
        sub={<>{memberName(c)}{c.member_no ? ` (${c.member_no})` : ''} · {fmtDate(c.starts_on)}{c.ends_on !== c.starts_on ? ` – ${fmtDate(c.ends_on)}` : ''} · {c.pax} pax · <StatusPill status={c.status} />{payStatus && <span className="pay-badge" data-testid="charter-pay-badge"><StatusPill status={payStatus} /></span>}</>}
        actions={isOps && <>
          {c.status === 'accepted' && (
            <button className="btn btn-gold" onClick={confirm} disabled={!!busy || !hasCrew} title={hasCrew ? '' : 'Assign captain and first officer first'}>
              {busy === 'confirm' ? 'Confirming…' : 'Confirm charter'}
            </button>
          )}
          {EDITABLE.includes(c.status) && <button className="btn btn-danger" onClick={() => setCancelling(true)}>Cancel charter</button>}
        </>} />
      <ErrorAlert error={actErr} />
      <OkAlert>{ok}</OkAlert>

      <div className="card card-pad"><Timeline charter={c} /></div>

      <div className="grid grid-side" style={{ marginTop: 20 }}>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Legs</h2><span className="muted xs">{aircraftReg(c)} · {aircraftType(c)}</span></div>
            <LegsTable legs={c.legs} showBlock={['flown', 'closed'].includes(c.status)} />
            {c.defects && <div className="card-body"><div className="alert alert-warn" style={{ margin: 0 }}><strong>Defects reported:</strong> {c.defects}</div></div>}
          </div>

          <ManifestEditor charter={c}
            canEdit={isOps && EDITABLE.includes(c.status)}
            canSubmit={isOps && ['accepted', 'confirmed'].includes(c.status)}
            onChanged={reload} />

          {isOps && c.status === 'manifest_complete' && (
            <div className="card">
              <div className="card-head"><h2>Flight log</h2>{awaitingPayment ? <StatusPill status={payStatus} label="Awaiting payment" /> : <span className="muted xs">Enter block times for every passenger leg</span>}</div>
              <div className="card-body"><FlightLogForm charter={c} awaitingPayment={awaitingPayment} onDone={() => { setOk('Flight log recorded — charter marked flown.'); reload(); }} /></div>
            </div>
          )}

          {c.events?.length > 0 && (
            <div className="card">
              <div className="card-head"><h2>Activity</h2></div>
              <div className="card-body">
                <ul className="events">
                  {c.events.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((e, i) => (
                    <li key={e.id || i}>
                      <span><strong>{humanize(e.action)}</strong>{e.actor_name ? <span className="muted"> · {e.actor_name}</span> : null}
                        {e.detail?.reason && <span className="muted"> — {e.detail.reason}</span>}</span>
                      <span className="muted nowrap">{fmtDateTime(e.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="stack">
          {isOps && EDITABLE.includes(c.status)
            ? <AssignPanel charter={c} onSaved={() => { setOk('Assignment saved.'); reload(); }} />
            : (
              <div className="card card-pad">
                <h3 style={{ marginBottom: 12 }}>Aircraft &amp; crew</h3>
                <dl className="dl">
                  <dt>Aircraft</dt><dd>{aircraftReg(c)} · {aircraftType(c)}</dd>
                  <dt>Captain</dt><dd>{crewName(c, 'captain') || '—'}</dd>
                  <dt>First officer</dt><dd>{crewName(c, 'first_officer') || '—'}</dd>
                  <dt>Cabin crew</dt><dd>{crewName(c, 'cabin_crew') || '—'}</dd>
                </dl>
              </div>
            )}
          {Array.isArray(emptyLegs) && (
            <EmptyLegsPanel charter={c} legs={emptyLegs} canGenerate={['sales', 'ops', 'admin'].includes(user.role)}
              listPath={emptyLegsPath(user.role)} onGenerated={(n) => { setOk(n ? `${n} empty leg${n > 1 ? 's' : ''} generated as draft.` : 'No positioning legs to generate.'); reload(); }} />
          )}
          {inv && <InvoiceCard inv={inv} canPay={['sales', 'admin'].includes(user.role) && c.status !== 'cancelled'} onChanged={reload} />}
          {c.ops_notes && <div className="card card-pad"><h3 style={{ marginBottom: 8 }}>Ops notes</h3><p className="small">{c.ops_notes}</p></div>}
        </div>
      </div>

      {cancelling && (
        <CancelModal path={`/api/charters/${id}/cancel`} warning="The aircraft and crew are released and the invoice is cancelled. The member is notified."
          refundQuotePath={`/api/charters/${id}/cancellation-quote`} operator doneLabel="Charter cancelled"
          onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); reload(); }} />
      )}
    </>
  );
}

function AssignPanel({ charter: c, onSaved }) {
  const { data: crew, error: crewErr } = useFetch('/api/crew');
  const { data: aircraft } = useFetch('/api/aircraft');
  const [f, setF] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setF({
      aircraft_id: c.aircraft_id || '',
      captain_id: c.captain_id || '',
      first_officer_id: c.first_officer_id || '',
      cabin_crew_id: c.cabin_crew_id || '',
    });
  }, [c]);

  const active = (crew || []).filter(m => m.is_active !== false);
  const byRole = (r) => active.filter(m => m.crew_role === r)
    .sort((a, b) => (b.base === homeBase) - (a.base === homeBase) || a.name.localeCompare(b.name));
  const currentAc = (aircraft || []).find(a => a.id === f.aircraft_id);
  const homeBase = currentAc?.home_base;
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    if (!f.captain_id || !f.first_officer_id) { setError('Captain and first officer are required.'); return; }
    setSaving(true); setError('');
    try {
      const body = { captain_id: f.captain_id, first_officer_id: f.first_officer_id, cabin_crew_id: f.cabin_crew_id || null };
      if (f.aircraft_id && f.aircraft_id !== c.aircraft_id) body.aircraft_id = f.aircraft_id;
      await api.post(`/api/charters/${c.id}/assign`, body);
      onSaved();
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };

  const crewSelect = (k, role, label, optional) => (
    <div className="field">
      <label>{label}</label>
      <select className="select" data-testid={`assign-${role}`} value={f[k] || ''} onChange={set(k)}>
        <option value="">{optional ? 'None' : 'Select…'}</option>
        {byRole(role).map(m => <option key={m.id} value={m.id}>{m.name} · {m.base}</option>)}
      </select>
    </div>
  );

  return (
    <form className="card card-pad" onSubmit={save}>
      <h3 style={{ marginBottom: 14 }}>Assign aircraft &amp; crew</h3>
      <ErrorAlert error={crewErr} />
      <div className="stack" style={{ '--gap': '12px' }}>
        <div className="field">
          <label>Aircraft</label>
          <select className="select" value={f.aircraft_id || ''} onChange={set('aircraft_id')}>
            {(aircraft || []).filter(a => a.status !== 'inactive' || a.id === c.aircraft_id).map(a => (
              <option key={a.id} value={a.id} disabled={Number(a.seats) < Number(c.pax)}>
                {a.registration} · {a.type} · {a.seats} seats{Number(a.seats) < Number(c.pax) ? ' (too small)' : ''}
              </option>
            ))}
          </select>
          {f.aircraft_id && f.aircraft_id !== c.aircraft_id && <span className="hint">Changing aircraft re-checks seats and availability; the price is not changed.</span>}
        </div>
        {crewSelect('captain_id', 'captain', 'Captain')}
        {crewSelect('first_officer_id', 'first_officer', 'First officer')}
        {crewSelect('cabin_crew_id', 'cabin_crew', 'Cabin crew', true)}
      </div>
      {homeBase && <p className="hint" style={{ marginTop: 10 }}>Crew based at {homeBase} are listed first.</p>}
      <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>
      <div className="form-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-primary btn-block" disabled={saving}>{saving ? 'Saving…' : 'Save assignment'}</button>
      </div>
    </form>
  );
}

function InvoiceCard({ inv, canPay, onChanged }) {
  const [err, setErr] = useState('');
  return (
    <PaymentCard key={inv.id} invoice={inv} canPay={canPay} onChanged={onChanged} title="Invoice & payment">
      <button className="btn btn-sm" onClick={async () => { setErr(''); try { await openPdf(`/api/invoices/${inv.id}/pdf`); } catch (e) { setErr(e.message); } }}>Invoice PDF</button>
      <Link to="/s/invoices" className="btn btn-sm btn-ghost">All invoices</Link>
      <ErrorAlert error={err} />
    </PaymentCard>
  );
}

function EmptyLegsPanel({ charter: c, legs, canGenerate, listPath, onGenerated }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const list = legs.map(normLeg);
  const canGen = canGenerate && ['accepted', 'confirmed', 'manifest_complete'].includes(c.status);
  const generate = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/api/empty-legs/generate/${c.id}`);
      const d = r.data;
      onGenerated(typeof d?.created === 'number' ? d.created : Array.isArray(d) ? d.length : Array.isArray(d?.created) ? d.created.length : Array.isArray(d?.empty_legs) ? d.empty_legs.length : 1);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <h3>Empty legs from this charter</h3>
        <Link to={listPath} className="xs nowrap">View all →</Link>
      </div>
      {list.length === 0 ? (
        <>
          <p className="small muted">No empty legs yet. Positioning flights can be sold as discounted whole-aircraft charters.</p>
          {canGen && <button className="btn btn-sm btn-gold" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate empty legs'}</button>}
        </>
      ) : (
        <ul className="el-mini">
          {list.map(l => {
            const w = legWindow(l);
            return (
              <li key={l.id}>
                <div>
                  <Link to={listPath} className="strong">{legRoute(l)}</Link>
                  <div className="muted xs">{l.leg_no} · {w.day} {w.range}{l.price_inr != null ? ` · ${inr(l.price_inr)}` : ''}</div>
                </div>
                <StatusPill status={l.status} />
              </li>
            );
          })}
        </ul>
      )}
      <ErrorAlert error={err} />
    </div>
  );
}
