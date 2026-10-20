import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api, { errText, openPdf } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, Modal } from '../../components/ui';
import PaymentCard from '../../components/PaymentCard';
import { fmtDate, inr, istDate, memberName } from '../../lib/format';
import { invoiceMoney, isPayable, dueInfo } from '../../lib/payments';

export default function Invoices() {
  const { user } = useAuth();
  const isMember = user.role === 'member';
  const canMarkPaid = ['sales', 'admin'].includes(user.role);
  const canPay = isMember || canMarkPaid;
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') || '');
  const { data, error, loading, reload } = useFetch(`/api/invoices${status ? `?status=${status}` : ''}`);
  const [pdfErr, setPdfErr] = useState('');
  const [paying, setPaying] = useState(null);
  const [open, setOpen] = useState(null);
  const list = data || [];
  const outstanding = list.filter(isPayable).reduce((s, i) => s + invoiceMoney(i).balance, 0);

  const pdf = async (inv) => { setPdfErr(''); try { await openPdf(`/api/invoices/${inv.id}/pdf`); } catch (e) { setPdfErr(e.message); } };
  const charterLink = (inv) => inv.charter_id ? (isMember ? `/m/trips/${inv.charter_id}` : `/o/charters/${inv.charter_id}`) : null;

  return (
    <>
      <PageHead eyebrow="Billing" title="Invoices" sub={outstanding ? `${inr(outstanding)} outstanding in this view` : null} />
      <div className="filters">
        <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="unpaid">Unpaid</option>
          <option value="partially_paid">Part paid</option>
          <option value="paid">Paid</option>
          <option value="refunded">Refunded</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <ErrorAlert error={error || pdfErr} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No invoices">{isMember ? 'Invoices are issued when you accept a quote.' : 'No invoices match this filter.'}</Empty></div>
      ) : isMember ? (
        <div className="cards">
          {list.map(inv => {
            const m = invoiceMoney(inv);
            const payable = isPayable(inv);
            const due = payable ? dueInfo(inv) : null;
            return (
              <div key={inv.id} className="trip-card inv-card" data-testid="invoice-card">
                <div className="top"><span className="date">Issued {fmtDate(inv.issued_on, { year: false })}</span><StatusPill status={inv.status} /></div>
                <div className="route">{inr(payable ? m.balance : m.total)}{payable && m.paid > 0 ? <span className="money-sub">balance of {inr(m.total)}</span> : null}</div>
                <div className="money">
                  <span>Total <strong>{inr(m.total)}</strong></span>
                  <span>Paid <strong>{inr(m.paid)}</strong></span>
                </div>
                {due && <div className={`pay-due ${due.urgency}`}><span className="ico" aria-hidden>◷</span><span>Pay by <strong>{due.label}</strong> · {due.left}</span></div>}
                <div className="meta">
                  <span>{inv.invoice_no}</span>
                  {inv.charter_no && <span>{inv.charter_no}</span>}
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  {payable
                    ? <button className="btn btn-sm btn-gold" onClick={() => setOpen(inv)}>Pay now</button>
                    : <button className="btn btn-sm" onClick={() => setOpen(inv)}>Payments</button>}
                  <button className="btn btn-sm" onClick={() => pdf(inv)}>PDF</button>
                  {charterLink(inv) && <Link className="btn btn-sm btn-ghost" to={charterLink(inv)}>View trip</Link>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Invoice</th><th>Member</th><th>Charter</th><th>Pay by</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.map(inv => {
                const m = invoiceMoney(inv);
                const payable = isPayable(inv);
                const due = payable ? dueInfo(inv) : null;
                const late = payable && (due ? due.urgency === 'over' : inv.due_on && inv.due_on < istDate());
                return (
                  <tr key={inv.id} data-testid="invoice-row" data-invoice-no={inv.invoice_no}>
                    <td className="strong nowrap"><button className="link-btn strong" onClick={() => setOpen(inv)}>{inv.invoice_no}</button></td>
                    <td>{memberName(inv)}</td>
                    <td className="nowrap">{charterLink(inv) ? <Link to={charterLink(inv)}>{inv.charter_no || 'View'}</Link> : inv.charter_no}</td>
                    <td className="nowrap small" style={late ? { color: 'var(--red-fg)', fontWeight: 600 } : due?.urgency === 'urgent' || due?.urgency === 'soon' ? { color: 'var(--amber-fg)', fontWeight: 600 } : undefined}>
                      {due ? <>{due.label}<span className="money-sub">{due.left}</span></> : payable ? fmtDate(inv.due_on, { year: false }) : <span className="muted">{inv.paid_on ? `Paid ${fmtDate(inv.paid_on, { year: false })}` : '—'}</span>}
                    </td>
                    <td className="num nowrap">{inr(m.total)}</td>
                    <td className="num nowrap">{inr(m.paid)}</td>
                    <td className="num nowrap strong">{payable ? inr(m.balance) : <span className="muted">—</span>}</td>
                    <td><StatusPill status={inv.status} /></td>
                    <td className="nowrap">
                      <div className="actions" style={{ flexWrap: 'nowrap' }}>
                        <button className="btn btn-sm" onClick={() => setOpen(inv)}>Details</button>
                        {canMarkPaid && payable && <button className="btn btn-sm btn-gold" onClick={() => setPaying(inv)}>Mark paid</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <Modal title={`Invoice ${open.invoice_no}`} onClose={() => setOpen(null)} wide>
          <PaymentCard flat invoice={open} canPay={canPay} onChanged={reload} title={memberName(open) !== '—' && !isMember ? memberName(open) : open.charter_no || 'Payment'}>
            <button className="btn btn-sm" onClick={() => pdf(open)}>Invoice PDF</button>
            {charterLink(open) && <Link className="btn btn-sm btn-ghost" to={charterLink(open)}>{isMember ? 'View trip' : 'Open charter'}</Link>}
          </PaymentCard>
        </Modal>
      )}
      {paying && <MarkPaid inv={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); reload(); }} />}
    </>
  );
}

function MarkPaid({ inv, onClose, onDone }) {
  const [paidOn, setPaidOn] = useState(istDate());
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { balance } = invoiceMoney(inv);
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try { await api.post(`/api/invoices/${inv.id}/mark-paid`, { paid_on: paidOn, payment_ref: ref }); onDone(); }
    catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };
  return (
    <Modal title={`Mark ${inv.invoice_no} paid`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="small muted">Records a manual bank transfer for the balance of <strong>{inr(balance)}</strong>. Use this only for payments received outside the member’s virtual account. If the charter has been flown it will close automatically.</p>
        <div className="form-grid">
          <div className="field"><label>Paid on</label><input className="input" type="date" required value={paidOn} onChange={e => setPaidOn(e.target.value)} /></div>
          <div className="field"><label>Payment reference</label><input className="input" required value={ref} onChange={e => setRef(e.target.value)} placeholder="UTR / NEFT ref" /></div>
        </div>
        <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Mark paid'}</button></div>
      </form>
    </Modal>
  );
}
