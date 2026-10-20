import { useEffect, useState, useCallback } from 'react';
import api, { errText } from '../api';
import { useAuth } from '../context/AuthContext';
import { useFetch } from '../lib/useFetch';
import { StatusPill, ErrorAlert, OkAlert, Modal, CopyButton, Loading } from './ui';
import { inr, fmtDateTime } from '../lib/format';
import {
  UPI_LIMIT_INR, invoiceMoney, isPayable, dueInfo, getPaymentsConfig, loadRazorpay, normInvoice, methodLabel, paymentFee,
} from '../lib/payments';

/**
 * Payment card for one invoice: amounts, deadline, status, and (when allowed) the two ways to pay.
 * `invoice` may be a light row (from a charter or list); the full detail (payments, refunds) is fetched here.
 */
export default function PaymentCard({ invoice, canPay = false, onChanged, title = 'Payment', children, flat }) {
  const { user } = useAuth();
  const isStaff = user?.role && user.role !== 'member';
  const detail = useFetch(invoice?.id ? `/api/invoices/${invoice.id}` : null);
  const inv = { ...invoice, ...(normInvoice(detail.data) || {}) };
  const { total, paid, balance } = invoiceMoney(inv);
  const payable = isPayable(inv);
  const due = payable ? dueInfo(inv) : null;
  const overLimit = balance > UPI_LIMIT_INR;

  const [tab, setTab] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [ok, setOk] = useState('');
  const [mockOrder, setMockOrder] = useState(null);
  const [, tick] = useState(0);

  // Bank transfer recommended above ₹5 lakh (UPI cap); otherwise default to the instant methods.
  const activeTab = tab || (overLimit ? 'bank' : 'online');

  useEffect(() => { if (canPay && payable) getPaymentsConfig().then(setCfg).catch(() => {}); }, [canPay, payable]);
  // Keep the countdown honest while the page stays open.
  useEffect(() => { if (!due) return; const t = setInterval(() => tick(x => x + 1), 60000); return () => clearInterval(t); }, [!!due]);

  const refresh = useCallback(() => { detail.reload(); onChanged?.(); }, [detail.reload, onChanged]);

  const payOnline = async () => {
    setBusy(true); setErr(''); setInfo(''); setOk('');
    try {
      const config = cfg || await getPaymentsConfig().catch(() => null);
      const { data: order } = await api.post(`/api/invoices/${inv.id}/pay`);
      const provider = order?.provider || config?.provider;
      if (provider === 'mock') { setMockOrder(order); setBusy(false); return; }

      const Razorpay = await loadRazorpay();
      const rzp = new Razorpay({
        key: order.key_id || config?.key_id,
        amount: order.amount_paise,
        currency: order.currency || 'INR',
        order_id: order.order_id,
        name: 'Meridian Charters',
        description: order.description || `Invoice ${order.invoice_no || inv.invoice_no}`,
        prefill: order.prefill || {},
        notes: { invoice_no: order.invoice_no || inv.invoice_no },
        theme: { color: '#171032' },
        handler: async (resp) => {
          setBusy(true); setErr(''); setInfo('');
          try {
            await api.post('/api/payments/verify', {
              razorpay_order_id: resp.razorpay_order_id,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature,
            });
            setOk('Payment received — thank you. A receipt is on its way to your email.');
            refresh();
          } catch (e) {
            setErr(`${errText(e)} If money left your account, it is matched automatically within a few minutes — no need to pay again.`);
            refresh();
          } finally { setBusy(false); }
        },
        modal: {
          ondismiss: () => { setBusy(false); setInfo('Payment window closed — nothing was charged. You can try again whenever you’re ready.'); },
        },
      });
      rzp.on('payment.failed', (r) => {
        setErr(`Payment didn’t go through${r?.error?.description ? `: ${r.error.description}` : ''}. Try again, use another method, or pay by bank transfer.`);
      });
      rzp.open();
    } catch (e) {
      setErr(errText(e)); setBusy(false);
    }
  };

  const status = inv.status;
  const payments = Array.isArray(inv.payments) ? inv.payments : [];
  const refunds = Array.isArray(inv.refunds) ? inv.refunds : [];

  return (
    <div className={`card pay-card ${flat ? 'flat' : ''}`} data-testid="payment-card">
      <div className="card-head">
        <h3>{title}</h3>
        <div className="actions">
          {inv.invoice_no && <span className="muted xs">{inv.invoice_no}</span>}
          <StatusPill status={status} />
        </div>
      </div>
      <div className="card-body">
        <div className="pay-amounts">
          <div><div className="label">Total</div><div className="v">{inr(total)}</div></div>
          <div><div className="label">Paid</div><div className="v">{inr(paid)}</div></div>
          <div className={payable ? 'bal' : ''}><div className="label">Balance</div><div className="v">{inr(balance)}</div></div>
        </div>

        {due && (
          <div className={`pay-due ${due.urgency}`} data-testid="pay-due">
            <span className="ico" aria-hidden>◷</span>
            <span>Pay by <strong>{due.label}</strong> · {due.left}</span>
          </div>
        )}
        {payable && due?.urgency !== 'over' && (
          <p className="xs muted" style={{ margin: '8px 0 0' }}>Full payment is due 24 hours before departure. Unpaid trips are released automatically at the deadline.</p>
        )}

        <div style={{ marginTop: 14 }}>
          <OkAlert>{ok}</OkAlert>
          {info && <div className="alert alert-info">{info}</div>}
          <ErrorAlert error={err || detail.error} />
        </div>

        {payable && canPay && (
          <div className="pay-methods">
            <div className="pay-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={activeTab === 'bank'} className={activeTab === 'bank' ? 'on' : ''} onClick={() => setTab('bank')}>
                <span className="t">Bank transfer</span>
                <span className="s">{overLimit ? 'Recommended for this amount' : 'NEFT · RTGS · IMPS'}</span>
              </button>
              <button type="button" role="tab" aria-selected={activeTab === 'online'} className={activeTab === 'online' ? 'on' : ''} onClick={() => setTab('online')}>
                <span className="t">Card, UPI or netbanking</span>
                <span className="s">Instant, via Razorpay</span>
              </button>
            </div>
            {activeTab === 'bank'
              ? <BankTransfer memberId={isStaff ? inv.member_id : null} balance={balance} invoiceNo={inv.invoice_no} />
              : (
                <div className="pay-pane">
                  {overLimit && (
                    <div className="alert alert-warn">
                      UPI is limited to ₹5 lakh per payment for travel. For {inr(balance)}, use card or netbanking — or a bank transfer, which we recommend for amounts above ₹5 lakh.
                    </div>
                  )}
                  <p className="small" style={{ marginBottom: 12 }}>You’ll pay <strong>{inr(balance)}</strong> securely on Razorpay. Meridian never sees your card details and absorbs all gateway fees.</p>
                  <button className="btn btn-gold btn-block pay-btn" onClick={payOnline} disabled={busy} data-testid="pay-online">
                    {busy ? 'Opening secure checkout…' : `Pay ${inr(balance)}`}
                  </button>
                  {cfg?.provider === 'mock' && <p className="xs muted" style={{ margin: '8px 0 0', textAlign: 'center' }}><span className="test-badge sm">Test mode</span> Payments are simulated — no money moves.</p>}
                </div>
              )}
          </div>
        )}

        {payable && !canPay && isStaff && <p className="small muted">Awaiting payment from the member.</p>}

        {(payments.length > 0 || refunds.length > 0) && (
          <div className="pay-history">
            {payments.length > 0 && <>
              <div className="label">Payments</div>
              <ul className="el-mini">
                {payments.map((p, i) => (
                  <li key={p.id || i}>
                    <div>
                      <span className="strong">{methodLabel(p.method)}</span>
                      <div className="muted xs">{fmtDateTime(p.captured_at || p.created_at)}{isStaff && paymentFee(p) ? ` · fee ${inr(paymentFee(p))} absorbed` : ''}</div>
                    </div>
                    <span className="nowrap strong">{inr(p.amount)}</span>
                  </li>
                ))}
              </ul>
            </>}
            {refunds.length > 0 && <>
              <div className="label" style={{ marginTop: 10 }}>Refunds</div>
              <ul className="el-mini">
                {refunds.map((r, i) => (
                  <li key={r.id || i}>
                    <div>
                      <span className="strong">Refund{r.policy_pct != null ? ` · ${Number(r.policy_pct)}%` : ''}</span>
                      <div className="muted xs">{fmtDateTime(r.created_at)}{r.reason ? ` · ${r.reason}` : ''}</div>
                    </div>
                    <span className="actions nowrap"><span className="strong">−{inr(r.amount)}</span>{r.status && <StatusPill status={r.status} />}</span>
                  </li>
                ))}
              </ul>
            </>}
          </div>
        )}
        {detail.loading && !detail.data && <div className="xs muted" style={{ marginTop: 8 }}>Loading payment history…</div>}
        {children && <div className="actions" style={{ marginTop: 14 }}>{children}</div>}
      </div>

      {mockOrder && (
        <MockCheckout order={mockOrder} invoiceNo={inv.invoice_no} onClose={() => { setMockOrder(null); setInfo('Test payment cancelled — nothing was charged.'); }}
          onPaid={() => { setMockOrder(null); setOk('Payment received — thank you. A receipt is on its way to your email.'); refresh(); }} />
      )}
    </div>
  );
}

function BankTransfer({ memberId, balance, invoiceNo }) {
  const { data, error, loading } = useFetch(memberId ? `/api/members/${memberId}/bank-transfer` : '/api/members/me/bank-transfer');
  const va = data?.bank_transfer || data?.virtual_account || data;
  return (
    <div className="pay-pane" data-testid="bank-transfer">
      <ErrorAlert error={error} />
      {loading && !data ? <Loading label="Fetching your account details…" /> : va && (
        <>
          <p className="small" style={{ marginBottom: 12 }}>Transfer <strong>{inr(balance)}</strong> by NEFT, RTGS or IMPS to {memberId ? 'the member’s' : 'your'} dedicated Meridian account{invoiceNo ? <> for <span className="nowrap">{invoiceNo}</span></> : null}.</p>
          <div className="bank">
            <BankRow label="Account name" value={va.account_name || va.name} />
            <BankRow label="Account number" value={va.account_number} mono />
            <BankRow label="IFSC" value={va.ifsc} mono />
            {va.bank_name && <BankRow label="Bank" value={va.bank_name} noCopy />}
          </div>
          <p className="xs muted" style={{ margin: '10px 0 0' }}>Transfers are matched automatically, usually within minutes. {memberId ? 'This account is unique to the member.' : 'This account is unique to you — use it for every Meridian invoice.'}</p>
        </>
      )}
    </div>
  );
}

function BankRow({ label, value, mono, noCopy }) {
  return (
    <div className="bank-row">
      <div className="bank-k">
        <div className="label">{label}</div>
        <div className={`bank-v ${mono ? 'mono' : ''}`}>{value || '—'}</div>
      </div>
      {!noCopy && value && <CopyButton value={value} what={label.toLowerCase()} />}
    </div>
  );
}

const MOCK_METHODS = [
  { id: 'card', t: 'Card', s: 'Visa, Mastercard, RuPay, Amex' },
  { id: 'upi', t: 'UPI', s: 'Any UPI app · up to ₹5 lakh' },
  { id: 'netbanking', t: 'Netbanking', s: 'All major Indian banks' },
];

/** In-app simulated checkout for PAYMENTS_PROVIDER=mock. */
function MockCheckout({ order, invoiceNo, onClose, onPaid }) {
  const amount = Number(order.amount_paise || 0) / 100;
  const upiBlocked = amount > UPI_LIMIT_INR;
  const [method, setMethod] = useState(upiBlocked ? 'card' : 'upi');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post('/api/payments/mock/complete', { order_id: order.order_id, method }); onPaid(); }
    catch (ex) { setErr(errText(ex)); setBusy(false); }
  };
  return (
    <Modal title={<span className="mock-title">Test payment <span className="test-badge">Test mode</span></span>} onClose={busy ? undefined : onClose}>
      <form onSubmit={submit} data-testid="mock-checkout">
        <div className="mock-sum">
          <div>
            <div className="label">Meridian Charters</div>
            <div className="small">{order.description || `Invoice ${order.invoice_no || invoiceNo}`}</div>
          </div>
          <div className="amt">{inr(amount)}</div>
        </div>
        <div className="alert alert-info" style={{ marginTop: 14 }}>
          This is a simulated checkout — no money moves. It stands in for Razorpay until live keys are configured, and confirms the payment to our server through the same signed webhook Razorpay uses.
        </div>
        <fieldset className="mock-methods">
          <legend className="label">Pay with</legend>
          {MOCK_METHODS.map(m => {
            const disabled = m.id === 'upi' && upiBlocked;
            return (
              <label key={m.id} className={`mock-method ${method === m.id ? 'on' : ''} ${disabled ? 'disabled' : ''}`}>
                <input type="radio" name="method" value={m.id} checked={method === m.id} disabled={disabled} onChange={() => setMethod(m.id)} />
                <span><span className="t">{m.t}</span><span className="s">{disabled ? 'Not available above ₹5 lakh per payment' : m.s}</span></span>
              </label>
            );
          })}
        </fieldset>
        <div style={{ marginTop: 12 }}><ErrorAlert error={err} /></div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-gold" disabled={busy} data-testid="mock-pay">{busy ? 'Processing…' : `Simulate payment of ${inr(amount)}`}</button>
        </div>
        <p className="xs muted" style={{ margin: '10px 0 0' }}>Order {order.order_id}</p>
      </form>
    </Modal>
  );
}
