import { useState } from 'react';
import api, { errText } from '../api';
import { useFetch } from '../lib/useFetch';
import { Modal, ErrorAlert } from './ui';
import { inr } from '../lib/format';

const POLICY = [
  { pct: 100, when: 'More than 7 days before departure' },
  { pct: 50, when: '48 hours to 7 days before departure' },
  { pct: 0, when: 'Within 48 hours of departure' },
];

/**
 * Generic cancel/reject dialog with a reason.
 * With `refundQuotePath` it first shows what the member gets back (GET …/cancellation-quote);
 * with `operator` staff can choose the refund % (default 100 — operator cancellations refund in full).
 */
export default function CancelModal({
  title = 'Cancel charter', path, body, onClose, onDone, confirmLabel = 'Cancel charter', requireReason = true, warning,
  refundQuotePath, operator = false, doneLabel = 'Cancelled',
}) {
  const [reason, setReason] = useState('');
  const [pct, setPct] = useState('100');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const quote = useFetch(refundQuotePath || null);
  const q = quote.data;
  const paid = Number(q?.amount_paid ?? 0);
  const pctNum = operator ? Math.max(0, Math.min(100, Number(pct) || 0)) : Number(q?.pct ?? 0);
  const refund = operator ? Math.round((paid * pctNum) / 100) : Number(q?.refund_amount ?? 0);

  const submit = async (e) => {
    e.preventDefault();
    if (requireReason && !reason.trim()) { setError('Please give a reason.'); return; }
    if (operator && refundQuotePath && (pct === '' || isNaN(Number(pct)) || Number(pct) < 0 || Number(pct) > 100)) { setError('Refund must be between 0 and 100%.'); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post(path, { ...(body || {}), reason: reason.trim() || undefined, ...(operator && refundQuotePath ? { refund_pct: Number(pct) } : {}) });
      if (refundQuotePath) { setResult(r.data?.refund || { pct: pctNum, amount: refund, guessed: true }); setSaving(false); }
      else onDone?.();
    } catch (err) { setError(errText(err)); setSaving(false); }
  };

  if (result) {
    const amt = Number(result.amount ?? 0);
    return (
      <Modal title={doneLabel} onClose={onDone}>
        <div className="refund-quote" data-testid="refund-result">
          {amt > 0 ? (
            <>
              <div className="big"><span className="amt">{inr(amt)}</span> will be refunded</div>
              <p className="small muted" style={{ margin: '6px 0 0' }}>{result.pct != null ? `${Number(result.pct)}% of the amount paid, ` : ''}back to the original payment method. Refunds usually reach the account within 5–7 working days.</p>
            </>
          ) : (
            <>
              <div className="big">No refund is due</div>
              <p className="small muted" style={{ margin: '6px 0 0' }}>{paid > 0 ? 'Under the cancellation policy nothing is refundable at this point.' : 'Nothing had been paid on this invoice.'}</p>
            </>
          )}
        </div>
        <p className="small muted">A confirmation has been emailed{operator ? ' to the member' : ''}.</p>
        <div className="form-actions"><button className="btn btn-primary" onClick={onDone}>Done</button></div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {refundQuotePath && (
          <div className="refund-quote" data-testid="refund-quote">
            {quote.loading && !q ? <div className="small muted">Working out your refund…</div>
              : quote.error ? <ErrorAlert error={`Couldn’t load the refund amount: ${quote.error}`} />
              : q && (
                <>
                  {operator ? (
                    <>
                      <div className="field" style={{ marginBottom: 10 }}>
                        <label htmlFor="refund-pct">Refund to member</label>
                        <div className="pct-row">
                          <input id="refund-pct" className="input" type="number" min="0" max="100" step="1" value={pct} onChange={e => setPct(e.target.value)} />
                          <span className="small">% of {inr(paid)} paid</span>
                        </div>
                        <span className="hint">Operator cancellations refund in full by default. Member policy would give {Number(q.pct ?? 0)}%.</span>
                      </div>
                      <div className="big">Member receives <span className="amt">{inr(refund)}</span> back</div>
                    </>
                  ) : paid > 0 ? (
                    <div className="big">You will receive <span className="amt">{inr(refund)}</span> back <span className="small muted" style={{ fontFamily: 'var(--font-sans)' }}>({pctNum}% of {inr(paid)} paid)</span></div>
                  ) : (
                    <><div className="big">Nothing has been paid yet</div><div className="small muted">No refund is involved.</div></>
                  )}
                  <ul className="refund-policy">
                    {POLICY.map(p => (
                      <li key={p.pct} className={!operator && paid > 0 && Number(q.pct) === p.pct ? 'on' : ''}><span>{p.when}</span><span className="nowrap">{p.pct ? `${p.pct}% refund` : 'No refund'}</span></li>
                    ))}
                  </ul>
                </>
              )}
          </div>
        )}
        {warning && <div className="alert alert-warn">{warning}</div>}
        <div className="field">
          <label>Reason{requireReason ? '' : ' (optional)'}</label>
          <textarea className="textarea" value={reason} onChange={e => setReason(e.target.value)} autoFocus={!refundQuotePath} />
        </div>
        <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-danger" disabled={saving}>{saving ? 'Working…' : confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
