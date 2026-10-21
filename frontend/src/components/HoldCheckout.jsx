import { useState } from 'react';
import { publicApi, errText } from '../api';
import { Modal, ErrorAlert } from './ui';
import { inr } from '../lib/format';
import { loadRazorpay, UPI_LIMIT_INR } from '../lib/payments';

const METHODS = [
  { id: 'upi', t: 'UPI', s: 'Google Pay, PhonePe, Paytm' },
  { id: 'card', t: 'Card', s: 'Visa, Mastercard, RuPay' },
  { id: 'netbanking', t: 'Netbanking', s: 'All major Indian banks' },
];

/**
 * Authorise (hold) the payment for a request on an operator's flight.
 * payment: the checkout payload from POST /api/public/empty-legs/:id/request.
 * Razorpay → opens Checkout and verifies; mock → an in-app test checkout. Calls onAuthorised(view) or onCancel().
 */
export async function openRazorpayHold({ token, payment, leg }) {
  const Razorpay = await loadRazorpay();
  return new Promise((resolve, reject) => {
    const rzp = new Razorpay({
      key: payment.key_id, order_id: payment.order_id, amount: Math.round(payment.amount * 100), currency: 'INR',
      name: 'Meridian Charters', description: `Empty leg ${leg.from_code} → ${leg.to_code} — held until the operator confirms`,
      prefill: payment.prefill || {}, theme: { color: '#171032' },
      handler: async (resp) => {
        try {
          const r = await publicApi.post(`/api/public/bookings/${token}/verify`, {
            razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature,
          });
          resolve(r.data);
        } catch (e) { reject(new Error(errText(e))); }
      },
      modal: { ondismiss: () => reject(Object.assign(new Error('dismissed'), { dismissed: true })) },
    });
    rzp.open();
  });
}

export default function MockHoldCheckout({ token, payment, onClose, onAuthorised }) {
  const upiBlocked = payment.amount > UPI_LIMIT_INR;
  const [method, setMethod] = useState(upiBlocked ? 'card' : 'upi');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await publicApi.post(`/api/public/bookings/${token}/mock-pay`, { method }); onAuthorised(r.data); }
    catch (ex) { setErr(errText(ex)); setBusy(false); }
  };
  return (
    <Modal title={<span className="mock-title">Test payment <span className="test-badge">Test mode</span></span>} onClose={busy ? undefined : onClose}>
      <form onSubmit={submit} data-testid="hold-checkout">
        <div className="mock-sum">
          <div>
            <div className="label">Meridian Charters</div>
            <div className="small">Held now · charged only if the operator confirms</div>
          </div>
          <div className="amt">{inr(payment.amount)}</div>
        </div>
        <div className="alert alert-info" style={{ marginTop: 14 }}>
          Simulated checkout — no money moves. With Razorpay the amount is authorised on your card or UPI now and captured only when the operator confirms.
        </div>
        <fieldset className="mock-methods">
          <legend className="label">Pay with</legend>
          {METHODS.map(m => {
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
          <button className="btn btn-gold" disabled={busy} data-testid="hold-pay">{busy ? 'Processing…' : `Authorise ${inr(payment.amount)}`}</button>
        </div>
      </form>
    </Modal>
  );
}
