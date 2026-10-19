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
                        <td className="num">{paxCount(c)}</td>
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
