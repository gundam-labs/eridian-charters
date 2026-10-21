import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty } from '../../components/ui';
import { inr, fmtDate, fmtDateTime } from '../../lib/format';

const LABEL = { pending: 'After the flight', due: 'Due', transferred: 'Paid out', paid: 'Paid out', cancelled: 'None (refunded)' };
const CLS = { pending: 'pill-blue', due: 'pill-amber', transferred: 'pill-green', paid: 'pill-green', cancelled: 'pill-grey' };

export default function ListerPayouts() {
  const { data, error, loading } = useFetch('/api/lister/payouts');
  const rows = data?.payouts || [];
  const t = data?.totals;
  return (
    <>
      <PageHead eyebrow="Lister" title="Payouts"
        sub="What travellers paid for your flights, our commission, and what you receive. Payouts become due once the flight has flown." />
      {data && !data.linked_account && (
        <div className="alert alert-info">Payouts are sent by bank transfer. To receive them automatically, ask us to link your Razorpay account.</div>
      )}
      {t && (
        <div className="stats">
          <div className="stat"><div className="label">Upcoming</div><div className="value">{inr(t.upcoming)}</div><div className="hint">flights not flown yet</div></div>
          <div className="stat"><div className="label">Due to you</div><div className="value">{inr(t.due)}</div></div>
          <div className="stat"><div className="label">Paid out</div><div className="value">{inr(t.paid)}</div></div>
        </div>
      )}
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : rows.length === 0 ? (
        <div className="card"><Empty title="No payouts yet">When you confirm a request, the traveller’s payment is charged and appears here.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Booking</th><th>Flight</th><th className="num">Traveller paid</th><th className="num">Commission</th><th className="num">You get</th><th>Payout</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="nowrap strong">{r.booking_no}<div className="muted xs">{fmtDateTime(r.captured_at)}</div></td>
                  <td className="nowrap">{r.from_code} → {r.to_code}<div className="muted xs">{r.leg_no} · {fmtDate(r.depart_earliest)}</div></td>
                  <td className="num nowrap">{inr(r.amount)}{r.refunded > 0 && <div className="muted xs">−{inr(r.refunded)} refunded</div>}</td>
                  <td className="num nowrap">{inr(r.commission)}<div className="muted xs">{r.commission_pct}% of fare</div></td>
                  <td className="num nowrap strong">{inr(r.payout)}</td>
                  <td className="nowrap"><span className={`pill ${CLS[r.payout_status] || 'pill-grey'}`}>{LABEL[r.payout_status] || r.payout_status}</span>
                    {r.payout_ref && <div className="muted xs">Ref {r.payout_ref}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
