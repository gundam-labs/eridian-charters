import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill } from '../../components/ui';
import { fmtDateTime, inr, istDate, addDays, memberName } from '../../lib/format';
import { methodLabel, getPaymentsConfig, METHOD_LABEL } from '../../lib/payments';

const RANGES = [
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: 'all', label: 'All time' },
];

/** GET /api/payments may return an array or {payments, totals}. */
function normPayments(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.payments || d.rows || [];
}

export default function Payments() {
  const [range, setRange] = useState('30');
  const [method, setMethod] = useState('');
  const [cfg, setCfg] = useState(null);
  useEffect(() => { getPaymentsConfig().then(setCfg).catch(() => {}); }, []);
  const today = istDate();
  const qs = range === 'all' ? '' : `?from=${addDays(today, -Number(range))}&to=${today}`;
  const { data, error, loading } = useFetch(`/api/payments${qs}`);
  const all = normPayments(data);
  const rows = method ? all.filter(p => p.method === method) : all;

  const t = useMemo(() => {
    const amount = rows.reduce((s, p) => s + Number(p.amount || 0), 0);
    const fees = rows.reduce((s, p) => s + Number(p.fee || 0), 0);
    return { amount, fees, net: amount - fees, count: rows.length, feePct: amount ? (fees / amount) * 100 : 0 };
  }, [rows]);
  const methods = [...new Set(all.map(p => p.method).filter(Boolean))];

  return (
    <>
      <PageHead eyebrow="Billing" title="Payments"
        sub="Every payment Razorpay has confirmed to us, and manual bank transfers. Gateway fees are absorbed by Meridian." />
      {cfg?.provider === 'mock' && (
        <div className="alert alert-info"><span className="test-badge sm">Test mode</span> Payments are simulated. To simulate an incoming bank transfer, open a member’s page and use “Simulate bank transfer”.</div>
      )}
      <div className="filters">
        <div className="seg" role="group" aria-label="Period">
          {RANGES.map(r => <button key={r.id} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>{r.label}</button>)}
        </div>
        <select className="select" value={method} onChange={e => setMethod(e.target.value)} aria-label="Method">
          <option value="">All methods</option>
          {(methods.length ? methods : Object.keys(METHOD_LABEL)).map(m => <option key={m} value={m}>{methodLabel(m)}</option>)}
        </select>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : (
        <>
          <div className="stats">
            <div className="stat"><div className="label">Collected</div><div className="value">{inr(t.amount)}</div><div className="hint">{t.count} payment{t.count === 1 ? '' : 's'}</div></div>
            <div className="stat"><div className="label">Fees absorbed</div><div className="value">{inr(t.fees)}</div><div className="hint">{t.feePct ? `${t.feePct.toFixed(2)}% of collected` : 'Bank transfers carry no fee'}</div></div>
            <div className="stat"><div className="label">Net received</div><div className="value">{inr(t.net)}</div></div>
          </div>
          {rows.length === 0 ? (
            <div className="card"><Empty title="No payments in this period">Payments appear here as soon as Razorpay confirms them.</Empty></div>
          ) : (
            <div className="card table-wrap">
              <table className="table" data-testid="payments-table">
                <thead><tr><th>Date (IST)</th><th>Member</th><th>Invoice</th><th>Method</th><th className="num">Amount</th><th className="num">Fee absorbed</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((p, i) => (
                    <tr key={p.id || i}>
                      <td className="nowrap">{fmtDateTime(p.captured_at || p.created_at)}</td>
                      <td>{p.member_id ? <Link to={`/s/members/${p.member_id}`}>{memberName(p)}</Link> : memberName(p)}{p.member_no && <span className="money-sub">{p.member_no}</span>}</td>
                      <td className="nowrap">
                        <span className="strong">{p.invoice_no || '—'}</span>
                        {p.charter_no && <span className="money-sub">{p.charter_id ? <Link to={`/o/charters/${p.charter_id}`}>{p.charter_no}</Link> : p.charter_no}</span>}
                      </td>
                      <td className="nowrap">{methodLabel(p.method)}{p.provider && p.provider !== 'razorpay' && <span className="money-sub">{p.provider === 'manual' ? 'Recorded manually' : p.provider === 'mock' ? 'Test mode' : p.provider}</span>}</td>
                      <td className="num nowrap strong">{inr(p.amount)}</td>
                      <td className="num nowrap">{Number(p.fee) ? inr(p.fee) : <span className="muted">—</span>}</td>
                      <td>{p.status ? <StatusPill status={p.status} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={4}>Total · {t.count} payment{t.count === 1 ? '' : 's'}</td><td className="num nowrap">{inr(t.amount)}</td><td className="num nowrap">{inr(t.fees)}</td><td /></tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
