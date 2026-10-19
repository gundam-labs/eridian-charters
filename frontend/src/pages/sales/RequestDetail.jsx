import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { normRequest, normSettings } from '../../lib/normalize';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, OkAlert } from '../../components/ui';
import QuoteBreakdown from '../../components/QuoteBreakdown';
import LegsTable from '../../components/LegsTable';
import LineItems from '../../components/LineItems';
import CancelModal from '../../components/CancelModal';
import { fmtDateTime, fmtDate, inr, istDate, addDays, memberName, hours } from '../../lib/format';

export default function SalesRequestDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useFetch(`/api/quote-requests/${id}`);
  const req = normRequest(data);
  const [editing, setEditing] = useState(null); // null | 'new' | quote object (draft)
  const [busy, setBusy] = useState('');
  const [actErr, setActErr] = useState('');
  const [ok, setOk] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // ?quote=<id> opens a draft in the builder
  useEffect(() => {
    const qid = params.get('quote');
    if (qid && req?.quotes) {
      const q = req.quotes.find(x => x.id === qid);
      if (q && q.status === 'draft') setEditing(q);
    }
  }, [params, req?.quotes]); // eslint-disable-line

  const act = async (q, action, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(q.id + action); setActErr(''); setOk('');
    try {
      const r = await api.post(`/api/quotes/${q.id}/${action}`);
      if (action === 'accept' && r.data?.charter?.id) { nav(`/o/charters/${r.data.charter.id}`); return; }
      setOk(`${q.quote_no} ${action === 'send' ? 'sent to member' : action === 'withdraw' ? 'withdrawn' : action + 'ed'}.`);
      reload();
    } catch (e) { setActErr(errText(e)); } finally { setBusy(''); }
  };

  if (loading && !req) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  if (!req) return null;

  const canQuote = ['open', 'quoted'].includes(req.status);
  const quotes = req.quotes || [];

  return (
    <>
      <PageHead
        back={<Link to="/s/requests" className="back">← Requests inbox</Link>}
        eyebrow={req.request_no}
        title={memberName(req)}
        sub={<>{req.member_no ? `${req.member_no} · ` : ''}{req.pax} pax · {req.legs?.length} leg{req.legs?.length === 1 ? '' : 's'} · received {fmtDateTime(req.created_at)} · <StatusPill status={req.status} /></>}
        actions={<>
          {canQuote && !editing && <button className="btn btn-primary" onClick={() => setEditing('new')}>Build a quote</button>}
          {canQuote && <button className="btn btn-danger" onClick={() => setCancelling(true)}>Cancel request</button>}
        </>}
      />
      <ErrorAlert error={actErr} />
      <OkAlert>{ok}</OkAlert>

      <div className="card">
        <div className="card-head"><h2>Requested itinerary</h2></div>
        <LegsTable legs={req.legs} />
        {req.notes && <div className="card-body small"><div className="label">Member notes</div><div>{req.notes}</div></div>}
      </div>

      {editing && (
        <QuoteBuilder
          key={editing === 'new' ? 'new' : editing.id}
          request={req}
          draft={editing === 'new' ? null : editing}
          onClose={() => { setEditing(null); if (params.get('quote')) setParams({}); }}
          onSaved={(msg) => { setEditing(null); setOk(msg); if (params.get('quote')) setParams({}); reload(); }}
        />
      )}

      <h2 style={{ margin: '28px 0 14px' }}>Quotes on this request</h2>
      {quotes.length === 0 ? (
        <div className="card"><Empty title="No quotes yet" action={canQuote && !editing && <button className="btn btn-primary" onClick={() => setEditing('new')}>Build a quote</button>}>
          Pick an aircraft and price the trip with the quote builder.
        </Empty></div>
      ) : quotes.map(q => (
        <div key={q.id} style={{ marginBottom: 16 }}>
          <QuoteBreakdown quote={q} staff actions={<>
            {q.status === 'draft' && <>
              <button className="btn btn-sm" onClick={() => setEditing(q)} disabled={!!busy}>Edit draft</button>
              <button className="btn btn-sm btn-gold" disabled={!!busy} onClick={() => act(q, 'send', `Send ${q.quote_no} to the member? The price will be recalculated.`)}>{busy === q.id + 'send' ? 'Sending…' : 'Send'}</button>
            </>}
            {q.status === 'sent' && (
              <button className="btn btn-sm" disabled={!!busy} onClick={() => act(q, 'accept', `Accept ${q.quote_no} on the member's behalf? This creates the charter and invoice.`)}>{busy === q.id + 'accept' ? 'Accepting…' : 'Accept for member'}</button>
            )}
            {['draft', 'sent'].includes(q.status) && (
              <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => act(q, 'withdraw', `Withdraw ${q.quote_no}?`)}>{busy === q.id + 'withdraw' ? 'Withdrawing…' : 'Withdraw'}</button>
            )}
          </>} />
        </div>
      ))}

      {cancelling && (
        <CancelModal title="Cancel request" path={`/api/quote-requests/${id}/cancel`} requireReason={false} confirmLabel="Cancel request"
          onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); reload(); }} />
      )}
    </>
  );
}

/* ─────────────────────────── Quote builder ─────────────────────────── */

function tripWindow(legs) {
  if (!legs?.length) return null;
  const first = istDate(legs[0].depart_at);
  const last = istDate(legs[legs.length - 1].depart_at);
  // pad a day either side for positioning flights
  return { from: addDays(first, -1), to: addDays(last, 1), first, last };
}

function QuoteBuilder({ request, draft, onClose, onSaved }) {
  const pax = Number(request.pax) || 1;
  const win = useMemo(() => tripWindow(request.legs), [request.legs]);
  const { data: aircraft, error: acErr, loading: acLoading } = useFetch('/api/aircraft');
  const { data: avail } = useFetch(win ? `/api/aircraft/availability?from=${win.from}&to=${win.to}` : null);
  const { data: settingsRaw } = useFetch('/api/settings');
  const settings = normSettings(settingsRaw);

  const [aircraftId, setAircraftId] = useState(draft?.aircraft_id || '');
  const [adjustment, setAdjustment] = useState(draft?.adjustment_inr ? String(draft.adjustment_inr) : '');
  const [adjNote, setAdjNote] = useState(draft?.adjustment_note || '');
  const [validHours, setValidHours] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    if (!validHours && settings.quote_validity_hours) setValidHours(String(settings.quote_validity_hours));
  }, [settings.quote_validity_hours]); // eslint-disable-line

  const availById = useMemo(() => {
    const m = {};
    (avail?.aircraft || []).forEach(a => { m[a.id] = a.cells || []; });
    return m;
  }, [avail]);

  const tripCells = (id) => (availById[id] || []);
  const isBusy = (id) => tripCells(id).some(c => c.date >= win.first && c.date <= win.last && c.state !== 'free');

  const list = useMemo(() => {
    const all = (aircraft || []).filter(a => showAll || (Number(a.seats) >= pax && a.status !== 'inactive'));
    return all.sort((a, b) => (isBusy(a.id) - isBusy(b.id)) || (a.seats - b.seats) || String(a.registration).localeCompare(b.registration));
  }, [aircraft, pax, showAll, availById]); // eslint-disable-line

  const adjNum = adjustment === '' || adjustment === '-' ? 0 : Number(adjustment);

  // live preview (debounced)
  useEffect(() => {
    if (!aircraftId) { setPreview(null); return; }
    if (isNaN(adjNum)) { setPreviewErr('Adjustment must be a number.'); return; }
    const my = ++seq.current;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.post('/api/quotes/preview', {
          request_id: request.id, aircraft_id: aircraftId, adjustment_inr: adjNum, adjustment_note: adjNote || undefined,
        });
        if (my === seq.current) { setPreview(r.data); setPreviewErr(''); }
      } catch (e) {
        if (my === seq.current) { setPreviewErr(errText(e)); setPreview(null); }
      } finally {
        if (my === seq.current) setPreviewing(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [aircraftId, adjNum, adjNote, request.id]);

  const body = () => ({
    request_id: request.id, aircraft_id: aircraftId, adjustment_inr: adjNum,
    adjustment_note: adjNote || undefined, valid_hours: validHours ? Number(validHours) : undefined,
  });

  const save = async (andSend) => {
    if (!aircraftId) { setError('Choose an aircraft first.'); return; }
    if (isNaN(adjNum)) { setError('Adjustment must be a number.'); return; }
    setSaving(andSend ? 'send' : 'draft'); setError('');
    try {
      let q;
      if (draft) {
        const { request_id, ...patch } = body(); // eslint-disable-line no-unused-vars
        q = (await api.patch(`/api/quotes/${draft.id}`, patch)).data;
      } else {
        q = (await api.post('/api/quotes', body())).data;
      }
      q = q?.quote || q;
      if (andSend) {
        await api.post(`/api/quotes/${q.id}/send`, validHours ? { valid_hours: Number(validHours) } : {});
        onSaved(`${q.quote_no || 'Quote'} sent to the member.`);
      } else {
        onSaved(`${q.quote_no || 'Draft'} saved as draft.`);
      }
    } catch (e) {
      setError(errText(e));
    } finally { setSaving(''); }
  };

  const conflicts = preview?.conflicts || [];
  const warnings = preview?.warnings || [];
  const selected = (aircraft || []).find(a => a.id === aircraftId);
  const validUntil = validHours ? new Date(Date.now() + Number(validHours) * 3600_000) : null;
  const days = win ? (avail?.days || []).filter(d => d >= win.from && d <= win.to) : [];

  return (
    <div className="card" style={{ marginTop: 20, borderColor: 'var(--gold-400)' }}>
      <div className="card-head">
        <div>
          <div className="eyebrow">{draft ? `Editing ${draft.quote_no}` : 'Quote builder'}</div>
          <h2>Price this trip</h2>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Close builder</button>
      </div>
      <div className="card-body">
        <div className="grid grid-2" style={{ alignItems: 'start' }}>
          {/* Aircraft picker */}
          <div>
            <div className="actions" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <div>
                <div className="label">Aircraft · {pax} pax</div>
                <div className="hint">Availability {win ? `${fmtDate(win.from, { year: false })} – ${fmtDate(win.to, { year: false })}` : ''} (±1 day for positioning)</div>
              </div>
              <label className="check xs"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show all</label>
            </div>
            <ErrorAlert error={acErr} />
            {acLoading ? <Loading /> : list.length === 0 ? (
              <Empty title="No aircraft fit">No active aircraft have {pax}+ seats.</Empty>
            ) : (
              <div className="ac-list">
                {list.map(a => {
                  const busy = isBusy(a.id);
                  const cells = tripCells(a.id).filter(c => c.date >= win.from && c.date <= win.to);
                  return (
                    <button type="button" key={a.id} data-testid="aircraft-option" data-reg={a.registration} data-busy={busy ? 'true' : 'false'} className={`ac-item ${aircraftId === a.id ? 'selected' : ''} ${busy ? 'busy' : ''}`} onClick={() => setAircraftId(a.id)}>
                      <div style={{ minWidth: 0 }}>
                        <div><span className="reg">{a.registration}</span> <span className="small">{a.type}</span></div>
                        <div className="meta">{a.seats} seats · base {a.home_base} · {a.cruise_speed_kts} kts{a.hourly_rate_inr ? ` · ${inr(a.hourly_rate_inr)}/hr` : ''}</div>
                        {cells.length > 0 && (
                          <div className="mini-cal" title={cells.map(c => `${c.date}: ${c.state}${c.label ? ` (${c.label})` : ''}`).join('\n')}>
                            {cells.map(c => <span key={c.date} className={c.state} />)}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        {a.status === 'inactive' ? <StatusPill status="inactive" /> : busy ? <span className="pill pill-red">Busy</span> : <span className="pill pill-green">Free</span>}
                        {Number(a.seats) < pax && <div className="xs" style={{ color: 'var(--red-fg)', marginTop: 4 }}>Too few seats</div>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {days.length > 0 && <div className="legend" style={{ marginTop: 10 }}>
              <span><i style={{ background: 'var(--cal-free)' }} />Free</span>
              <span><i style={{ background: 'var(--cal-charter)' }} />Charter</span>
              <span><i style={{ background: 'var(--cal-maint)' }} />Maintenance</span>
              <span><i style={{ background: 'var(--cal-inactive)' }} />Inactive</span>
            </div>}
          </div>

          {/* Pricing */}
          <div>
            <div className="form-grid">
              <div className="field">
                <label>Adjustment (INR)</label>
                <input className="input" inputMode="numeric" value={adjustment} onChange={e => setAdjustment(e.target.value.replace(/[^\d-]/g, ''))} placeholder="0 — negative for discount" />
              </div>
              <div className="field">
                <label>Valid for (hours)</label>
                <input className="input" type="number" min={1} max={720} value={validHours} onChange={e => setValidHours(e.target.value)} />
              </div>
              <div className="field span-2">
                <label>Adjustment note</label>
                <input className="input" value={adjNote} onChange={e => setAdjNote(e.target.value)} placeholder="e.g. Loyalty discount, catering" />
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              {!aircraftId ? (
                <div className="alert alert-info">Select an aircraft to see a live price.</div>
              ) : (
                <>
                  <ErrorAlert error={previewErr} />
                  {conflicts.length > 0 && (
                    <div className="alert alert-warn">
                      <strong>{selected?.registration} has conflicts for these dates.</strong> You can still send, but the member won’t be able to accept unless it frees up.
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {conflicts.map((c, i) => <li key={i}>{c.kind === 'maintenance' ? 'Maintenance' : 'Charter'} {c.ref || ''} · {fmtDate(c.starts_on, { year: false })} – {fmtDate(c.ends_on, { year: false })}</li>)}
                      </ul>
                    </div>
                  )}
                  {warnings.map((w, i) => <div key={i} className="alert alert-warn">{w}</div>)}
                  {preview && (
                    <>
                      <div className="price-box">
                        <div className="actions" style={{ justifyContent: 'space-between' }}>
                          <div>
                            <div className="label">Total incl. GST {previewing && <span className="spinner" style={{ marginLeft: 6, width: 12, height: 12 }} />}</div>
                            <div className="total" data-testid="preview-total">{inr(preview.total)}</div>
                          </div>
                          <div style={{ textAlign: 'right' }} className="small">
                            <div className="label">Validity</div>
                            <div>{validUntil ? `until ${fmtDateTime(validUntil)}` : '—'}</div>
                            <div className="xs" style={{ color: '#aebbd0' }}>from when it’s sent</div>
                          </div>
                        </div>
                        <div className="xs" style={{ color: '#aebbd0', marginTop: 8 }}>
                          {fmtDate(preview.starts_on, { year: false })} – {fmtDate(preview.ends_on, { year: false })} ·
                          {' '}{hours((preview.legs || []).reduce((s, l) => s + Number(l.flight_hours || 0), 0))} flying
                          {(preview.positioning || []).length > 0 && ` + ${hours(preview.positioning.reduce((s, l) => s + Number(l.flight_hours || 0), 0))} positioning`}
                        </div>
                      </div>
                      <div style={{ marginTop: 14 }} data-testid="preview-lines"><LineItems quote={preview} /></div>
                      <details style={{ marginTop: 12 }}>
                        <summary className="small" style={{ cursor: 'pointer' }}>Flight plan with positioning</summary>
                        <div style={{ marginTop: 10 }}><LegsTable legs={preview.legs} positioning={preview.positioning} /></div>
                      </details>
                    </>
                  )}
                  {!preview && previewing && <Loading label="Pricing…" />}
                </>
              )}
            </div>

            <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
            <div className="form-actions">
              <button className="btn" onClick={onClose} disabled={!!saving}>Cancel</button>
              <button className="btn" onClick={() => save(false)} disabled={!!saving || !aircraftId}>{saving === 'draft' ? 'Saving…' : 'Save draft'}</button>
              <button className="btn btn-gold" onClick={() => save(true)} disabled={!!saving || !aircraftId}>{saving === 'send' ? 'Sending…' : 'Send to member'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
