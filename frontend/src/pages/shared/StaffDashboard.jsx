import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill } from '../../components/ui';
import { countOf, inr, fmtDateTime, route, memberName, aircraftReg, paxCount } from '../../lib/format';

export default function StaffDashboard({ title = 'Dashboard', eyebrow }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const { data, error, loading } = useFetch('/api/dashboard');
  const charterBase = '/o/charters';
  const isSales = ['sales', 'admin'].includes(user.role);
  const isOps = ['ops', 'admin'].includes(user.role);
  const next7 = Array.isArray(data?.charters_next_7_days) ? data.charters_next_7_days : [];

  return (
    <>
      <PageHead eyebrow={eyebrow || `${user.role} · ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}`} title={title} />
      <ErrorAlert error={error} />
      {loading ? <Loading /> : data && (
        <>
          <div className="stats">
            <Stat to={isSales ? '/s/requests' : null} label="Open requests" value={countOf(data.open_requests)} />
            <Stat to={isSales ? '/s/quotes?status=sent' : null} label="Quotes sent" value={countOf(data.quotes_sent)} hint={`${countOf(data.quotes_expiring_24h)} expiring in 24h`} />
            <Stat to={charterBase} label="Awaiting confirmation" value={countOf(data.awaiting_confirmation)} />
            <Stat to={charterBase} label="Awaiting manifest" value={countOf(data.awaiting_manifest)} />
            <Stat to={isSales || user.role === 'ops' ? '/s/invoices' : null} label="Unpaid invoices" value={inr(data.unpaid_invoices_total)} />
            <Stat to={isOps ? '/o/maintenance' : null} label="In maintenance today" value={countOf(data.aircraft_in_maintenance_today)} />
            <Stat to={isOps ? '/o/calendar' : null} label="Fleet utilisation 30d" value={data.fleet_utilisation_30d_pct != null ? `${Math.round(Number(data.fleet_utilisation_30d_pct))}%` : '—'} />
          </div>
          {data.payments && <PaymentsCard p={data.payments} canSeePayments={isSales} />}
          {data.empty_legs && <EmptyLegsCard el={data.empty_legs} to={user.role === 'ops' ? '/o/empty-legs' : '/s/empty-legs'} />}
          <div className="card">
            <div className="card-head"><h2>Departing in the next 7 days</h2>{isOps && <Link to="/o/calendar" className="btn btn-sm">Fleet calendar</Link>}</div>
            {next7.length === 0 ? <Empty title="A quiet week">No charters depart in the next seven days.</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Charter</th><th>First departure</th><th>Route</th><th>Member</th><th>Aircraft</th><th className="num">Pax</th><th>Status</th></tr></thead>
                  <tbody>
                    {next7.map(c => (
                      <tr key={c.id} className="clickable" onClick={() => nav(`${charterBase}/${c.id}`)}>
                        <td className="strong nowrap"><Link to={`${charterBase}/${c.id}`}>{c.charter_no}</Link></td>
                        <td className="nowrap">{fmtDateTime(c.legs?.[0]?.depart_at) !== '—' ? fmtDateTime(c.legs[0].depart_at) : c.starts_on}</td>
                        <td className="nowrap">{route(c.legs)}</td>
                        <td>{memberName(c)}</td>
                        <td className="nowrap">{aircraftReg(c)}</td>
                        <td className="num">{c.pax ?? paxCount(c)}</td>
                        <td><StatusPill status={c.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Stat({ to, label, value, hint }) {
  const inner = <><div className="label">{label}</div><div className="value">{value}</div>{hint && <div className="hint">{hint}</div>}</>;
  return to ? <Link to={to} className="stat">{inner}</Link> : <div className="stat">{inner}</div>;
}

function EmptyLegsCard({ el, to }) {
  const pct = el.positioning_hours_sold_pct_90d;
  const pctNum = pct != null && !isNaN(Number(pct)) ? Math.max(0, Math.min(100, Math.round(Number(pct)))) : null;
  return (
    <div className="card el-dash">
      <div className="card-head">
        <h2>Empty legs</h2>
        <Link to={to} className="btn btn-sm">Manage empty legs</Link>
      </div>
      <div className="el-dash-grid">
        <Link to={to} className="el-dash-item"><div className="label">Published</div><div className="value">{countOf(el.published)}</div></Link>
        <Link to={`${to}?tab=requests`} className="el-dash-item">
          <div className="label">Pending requests</div>
          <div className="value">{countOf(el.pending_requests)}{countOf(el.pending_requests) > 0 && <span className="pill pill-amber" style={{ marginLeft: 8, verticalAlign: 'middle' }}>Action</span>}</div>
        </Link>
        <div className="el-dash-item"><div className="label">Revenue recovered · 90d</div><div className="value">{inr(el.revenue_recovered_90d_inr)}</div>
          {el.booked_90d != null && <div className="hint">{countOf(el.booked_90d)} leg{countOf(el.booked_90d) === 1 ? '' : 's'} sold</div>}</div>
        <div className="el-dash-item"><div className="label">Positioning hours sold · 90d</div><div className="value">{pctNum != null ? `${pctNum}%` : '—'}</div>
          {pctNum != null && <div className="el-bar" role="img" aria-label={`${pctNum}% of positioning hours sold`}><span style={{ width: `${pctNum}%` }} /></div>}</div>
      </div>
    </div>
  );
}

function PaymentsCard({ p, canSeePayments }) {
  const dueCount = countOf(p.unpaid_due_48h_count);
  const collected = Number(p.collected_30d || 0);
  const fees = Number(p.fees_30d || 0);
  const Item = ({ to, children }) => (to ? <Link to={to} className="el-dash-item">{children}</Link> : <div className="el-dash-item">{children}</div>);
  return (
    <div className="card el-dash" data-testid="dash-payments">
      <div className="card-head">
        <h2>Payments</h2>
        {canSeePayments && <Link to="/s/payments" className="btn btn-sm">All payments</Link>}
      </div>
      <div className="el-dash-grid three">
        <Item to={canSeePayments ? '/s/payments' : null}><div className="label">Collected · 30d</div><div className="value">{inr(collected)}</div></Item>
        <Item to={canSeePayments ? '/s/payments' : null}>
          <div className="label">Gateway fees absorbed · 30d</div><div className="value">{inr(fees)}</div>
          <div className="hint">{collected ? `${((fees / collected) * 100).toFixed(2)}% of collected` : 'No card or UPI payments yet'}</div>
        </Item>
        <Item to="/s/invoices?status=unpaid">
          <div className="label">Unpaid, due within 48 h</div>
          <div className="value">{dueCount}{dueCount > 0 && <span className="pill pill-amber" style={{ marginLeft: 8, verticalAlign: 'middle' }}>Chase</span>}</div>
          <div className="hint">{dueCount ? `${inr(p.unpaid_due_48h_amount)} outstanding — released automatically if unpaid` : 'Nothing at risk'}</div>
        </Item>
      </div>
    </div>
  );
}
