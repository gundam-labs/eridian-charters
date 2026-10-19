import { inr } from '../lib/format';

export default function LineItems({ quote, dark }) {
  const items = quote?.line_items || [];
  if (!items.length) return <p className="muted small">No line items.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr>
        </thead>
        <tbody>
          {items.map((li, i) => (
            <tr key={i}>
              <td>{li.description}{li.code === 'ADJUSTMENT' && <span className="muted xs"> · adjustment</span>}</td>
              <td className="num nowrap">{fmtQty(li)}</td>
              <td className="num nowrap">{li.code === 'ADJUSTMENT' ? '' : inr(li.rate)}</td>
              <td className="num nowrap" style={li.amount < 0 ? { color: 'var(--green-fg)' } : undefined}>{inr(li.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}>Subtotal</td><td className="num">{inr(quote.subtotal)}</td></tr>
          <tr><td colSpan={3}>GST {quote.gst_rate_pct != null ? `@ ${Number(quote.gst_rate_pct)}%` : ''}</td><td className="num">{inr(quote.gst_amount)}</td></tr>
          <tr style={dark ? undefined : { fontSize: '1rem' }}><td colSpan={3}>Total</td><td className="num">{inr(quote.total)}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}

function fmtQty(li) {
  if (li.qty == null) return '';
  const q = Number(li.qty);
  const s = Number.isInteger(q) ? String(q) : q.toFixed(1);
  return li.unit ? `${s} ${li.unit}` : s;
}
