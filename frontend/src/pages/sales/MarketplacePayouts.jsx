import { useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal, Toast } from '../../components/ui';
import { inr, fmtDate } from '../../lib/format';

const LABEL = { pending: 'After flight', due: 'Due', transferred: 'Transferred', paid: 'Paid', cancelled: 'Cancelled' };
const CLS = { pending: 'pill-blue', due: 'pill-amber', transferred: 'pill-green', paid: 'pill-green', cancelled: 'pill-grey' };
const WHO = [
  { value: 'traveller', label: 'Traveller cancelled', hint: '80% back >72 h before departure, 50% at 24–72 h, none <24 h' },
  { value: 'operator', label: 'Operator cancelled or no-show', hint: '100% refund' },
  { value: 'charter_change', label: 'Main charter changed', hint: '100% refund' },
  { value: 'force_majeure', label: 'Weather, ATC or technical', hint: '100% refund' },
];

/** Money collected for lister flights: commission, payouts to listers, and cancellations with the refund policy. */
export default function MarketplacePayouts() {
  const [filter, setFilter] = useState('');
  const { data, error, loading, reload } = useFetch(`/api/marketplace/payouts${filter ? `?payout_status=${filter}` : ''}`);
  const [paying, setPaying] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [actErr, setActErr] = useState('');
  const [toast, setToast] = useState('');
  const rows = data?.payouts || [];
  const t = data?.totals;

  const transfer = async (p) => {
    setActErr('');
    try { await api.post(`/api/marketplace/payouts/${p.id}/transfer`); setToast(`${inr(p.payout)} transferred to ${p.lister_company || p.lister_name}`); reload(); }
    catch (e) { setActErr(errText(e)); }
  };

  return (
    <>
      <PageHead eyebrow="Marketplace" title="Lister payouts"
        sub="Payments collected for flights listed by operators, agents and flyers. Our commission is kept; the rest is paid out after the flight." />
      {t && (
        <div className="stats">
          <div className="stat"><div className="label">Collected</div><div className="value">{inr(t.collected)}</div><div className="hint">{inr(t.refunded)} refunded</div></div>
          <div className="stat"><div className="label">Commission earned</div><div className="value">{inr(t.commission)}</div></div>
          <div className="stat"><div className="label">Payouts due</div><div className="value">{inr(t.due)}</div><div className="hint">{inr(t.pending)} after upcoming flights</div></div>
          <div className="stat"><div className="label">Paid out</div><div className="value">{inr(t.paid_out)}</div></div>
        </div>
      )}
      <div className="filters">
        <select className="select" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Payout status">
          <option value="">All payouts</option>
          {Object.entries(LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <ErrorAlert error={error || actErr} />
      {loading && !data ? <Loading /> : rows.length === 0 ? (
        <div className="card"><Empty title="No payments yet">When a lister confirms a request, the traveller’s held payment is charged and shows here.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Booking</th><th>Lister</th><th className="num">Paid</th><th className="num">Commission</th><th className="num">Payout</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.id}>
                  <td className="nowrap"><span className="strong">{p.booking_no}</span>
                    <div className="muted xs">{p.from_code} → {p.to_code} · {fmtDate(p.depart_earliest)} · {p.guest_name}</div></td>
                  <td>{p.lister_company || p.lister_name}<div className="muted xs">{p.razorpay_account_id ? `Route ${p.razorpay_account_id}` : 'Bank transfer'}</div></td>
                  <td className="num nowrap">{inr(p.amount)}{p.refunded > 0 && <div className="muted xs">−{inr(p.refunded)}</div>}</td>
                  <td className="num nowrap">{inr(p.commission)}</td>
                  <td className="num nowrap strong">{inr(p.payout)}</td>
                  <td className="nowrap"><span className={`pill ${CLS[p.payout_status] || 'pill-grey'}`}>{LABEL[p.payout_status] || p.payout_status}</span>
                    {p.payout_ref && <div className="muted xs">{p.payout_ref}</div>}
                    {p.payout_error && <div className="xs" style={{ color: 'var(--red-fg)' }}>{p.payout_error}</div>}</td>
                  <td className="right nowrap">
                    <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      {p.payout_status === 'due' && p.razorpay_account_id && <button className="btn btn-sm btn-gold" onClick={() => transfer(p)}>Transfer</button>}
                      {p.payout_status === 'due' && <button className="btn btn-sm" onClick={() => setPaying(p)}>Mark paid</button>}
                      {p.booking_status === 'confirmed' && <button className="btn btn-sm btn-danger" onClick={() => setCancelling(p)}>Cancel booking</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paying && <MarkPaidModal payout={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); setToast('Payout marked paid'); reload(); }} />}
      {cancelling && <CancelBookingModal payout={cancelling} onClose={() => setCancelling(null)}
        onDone={(r) => { setCancelling(null); setToast(r?.refund ? `Cancelled — ${inr(r.refund.amount)} (${r.refund.pct}%) refunded` : 'Cancelled'); reload(); }} />}
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function MarkPaidModal({ payout: p, onClose, onDone }) {
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try { await api.post(`/api/marketplace/payouts/${p.id}/mark-paid`, { reference: ref }); onDone(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  };
  return (
    <Modal title={`Pay ${p.lister_company || p.lister_name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p>Transfer <strong>{inr(p.payout)}</strong> to the lister’s bank account, then record the reference here.</p>
        <div className="field"><label htmlFor="mp-ref">Bank reference (UTR)</label>
          <input id="mp-ref" className="input" required value={ref} onChange={e => setRef(e.target.value)} /></div>
        <ErrorAlert error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Mark paid'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CancelBookingModal({ payout: p, onClose, onDone }) {
  const [who, setWho] = useState('traveller');
  const [reason, setReason] = useState('');
  const [pct, setPct] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!reason.trim()) { setError('Please give a reason — the traveller sees it.'); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post(`/api/marketplace/bookings/${p.booking_id}/cancel`, { who, reason: reason.trim(), refund_pct: pct === '' ? undefined : Number(pct) });
      onDone(r.data);
    } catch (err) { setError(errText(err)); setSaving(false); }
  };
  return (
    <Modal title={`Cancel ${p.booking_no}`} onClose={onClose}>
      <form onSubmit={submit}>
        <fieldset className="mock-methods">
          <legend className="label">Who cancelled?</legend>
          {WHO.map(w => (
            <label key={w.value} className={`mock-method ${who === w.value ? 'on' : ''}`}>
              <input type="radio" name="who" value={w.value} checked={who === w.value} onChange={() => setWho(w.value)} />
              <span><span className="t">{w.label}</span><span className="s">{w.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field span-2"><label htmlFor="cb-reason">Reason</label>
            <textarea id="cb-reason" className="textarea" rows={2} value={reason} onChange={e => setReason(e.target.value)} /></div>
          <div className="field"><label htmlFor="cb-pct">Refund % <span className="muted">— leave blank for the policy</span></label>
            <input id="cb-pct" className="input" type="number" min="0" max="100" value={pct} onChange={e => setPct(e.target.value)} /></div>
        </div>
        <ErrorAlert error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-danger" disabled={saving}>{saving ? 'Cancelling…' : 'Cancel and refund'}</button>
        </div>
      </form>
    </Modal>
  );
}
