import { useState } from 'react';
import { Link } from 'react-router-dom';
import api, { errText, openPdf } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, Modal } from '../../components/ui';
import { fmtDate, inr, istDate, memberName } from '../../lib/format';

export default function Invoices() {
  const { user } = useAuth();
  const isMember = user.role === 'member';
  const canMarkPaid = ['sales', 'admin'].includes(user.role);
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useFetch(`/api/invoices${status ? `?status=${status}` : ''}`);
  const [pdfErr, setPdfErr] = useState('');
  const [paying, setPaying] = useState(null);
  const list = data || [];
  const outstanding = list.filter(i => i.status === 'unpaid').reduce((s, i) => s + Number(i.total || 0), 0);

  const pdf = async (inv) => { setPdfErr(''); try { await openPdf(`/api/invoices/${inv.id}/pdf`); } catch (e) { setPdfErr(e.message); } };
  const charterLink = (inv) => inv.charter_id ? (isMember ? `/m/trips/${inv.charter_id}` : `/o/charters/${inv.charter_id}`) : null;

  return (
    <>
      <PageHead eyebrow="Billing" title="Invoices" sub={outstanding ? `${inr(outstanding)} outstanding in this view` : null} />
      <div className="filters">
        <select className="select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="unpaid">Unpaid</option><option value="paid">Paid</option><option value="cancelled">Cancelled</option>
        </select>
      </div>
      <ErrorAlert error={error || pdfErr} />
      {loading ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No invoices">{isMember ? 'Invoices are issued when you accept a quote.' : 'No invoices match this filter.'}</Empty></div>
      ) : isMember ? (
        <div className="cards">
          {list.map(inv => (
            <div key={inv.id} className="trip-card">
              <div className="top"><span className="date">Issued {fmtDate(inv.issued_on, { year: false })}</span><StatusPill status={inv.status} /></div>
              <div className="route">{inr(inv.total)}</div>
              <div className="meta">
                <span>{inv.invoice_no}</span>
                {inv.charter_no && <span>{inv.charter_no}</span>}
                <span>Due {fmtDate(inv.due_on, { year: false })}</span>
              </div>
              <div className="actions" style={{ marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => pdf(inv)}>Download PDF</button>
                {charterLink(inv) && <Link className="btn btn-sm btn-ghost" to={charterLink(inv)}>View trip</Link>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Invoice</th><th>Member</th><th>Charter</th><th>Issued</th><th>Due</th><th className="num">Total</th><th>Status</th><th>Payment</th><th /></tr></thead>
            <tbody>
              {list.map(inv => {
                const overdue = inv.status === 'unpaid' && inv.due_on && inv.due_on < istDate();
                return (
                  <tr key={inv.id} data-testid="invoice-row" data-invoice-no={inv.invoice_no}>
                    <td className="strong nowrap">{inv.invoice_no}</td>
                    <td>{memberName(inv)}</td>
                    <td className="nowrap">{charterLink(inv) ? <Link to={charterLink(inv)}>{inv.charter_no || 'View'}</Link> : inv.charter_no}</td>
                    <td className="nowrap">{fmtDate(inv.issued_on, { year: false })}</td>
                    <td className="nowrap" style={overdue ? { color: 'var(--red-fg)', fontWeight: 600 } : undefined}>{fmtDate(inv.due_on, { year: false })}{overdue ? ' · overdue' : ''}</td>
                    <td className="num nowrap">{inr(inv.total)}</td>
                    <td><StatusPill status={inv.status} /></td>
                    <td className="small">{inv.status === 'paid' ? <>{fmtDate(inv.paid_on, { year: false })}{inv.payment_ref ? <div className="muted xs">{inv.payment_ref}</div> : null}</> : '—'}</td>
                    <td className="nowrap">
                      <div className="actions">
                        <button className="btn btn-sm" onClick={() => pdf(inv)}>PDF</button>
                        {canMarkPaid && inv.status === 'unpaid' && <button className="btn btn-sm btn-gold" onClick={() => setPaying(inv)}>Mark paid</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try { await api.post(`/api/invoices/${inv.id}/mark-paid`, { paid_on: paidOn, payment_ref: ref }); onDone(); }
    catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };
  return (
    <Modal title={`Mark ${inv.invoice_no} paid`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="small muted">Amount: <strong>{inr(inv.total)}</strong>. If the charter has been flown it will close automatically.</p>
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
