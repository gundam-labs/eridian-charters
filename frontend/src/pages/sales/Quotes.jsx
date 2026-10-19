import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill } from '../../components/ui';
import { fmtDateTime, inr, route, memberName, aircraftReg } from '../../lib/format';

export default function Quotes() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const { data, error, loading } = useFetch(`/api/quotes${status ? `?status=${status}` : ''}`);
  const list = (data || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const [q, setQ] = useState('');
  const shown = list.filter(x => !q || `${x.quote_no} ${memberName(x)} ${aircraftReg(x)}`.toLowerCase().includes(q.toLowerCase()));
  const open = (x) => nav(`/s/requests/${x.request_id}${x.status === 'draft' ? `?quote=${x.id}` : ''}`);

  return (
    <>
      <PageHead eyebrow="Sales" title="Quotes" />
      <div className="filters">
        <input className="input search" placeholder="Search quote no, member, registration" value={q} onChange={e => setQ(e.target.value)} />
        <select className="select" value={status} onChange={e => setParams(e.target.value ? { status: e.target.value } : {})}>
          <option value="">All statuses</option>
          {['draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
      </div>
      <ErrorAlert error={error} />
      {loading ? <Loading /> : shown.length === 0 ? (
        <div className="card"><Empty title="No quotes">Quotes are built from the <Link to="/s/requests">requests inbox</Link>.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Quote</th><th>Member</th><th>Route</th><th>Aircraft</th><th className="num">Total</th><th>Status</th><th>Valid until</th><th>Created</th></tr></thead>
            <tbody>
              {shown.map(x => (
                <tr key={x.id} className="clickable" onClick={() => open(x)}>
                  <td className="strong nowrap">{x.quote_no}</td>
                  <td>{memberName(x)}</td>
                  <td className="nowrap">{route(x.legs)}</td>
                  <td className="nowrap">{aircraftReg(x)}<div className="muted xs">{x.aircraft_type}</div></td>
                  <td className="num nowrap">{inr(x.total)}</td>
                  <td><StatusPill status={x.status} /></td>
                  <td className="nowrap small">{x.valid_until ? fmtDateTime(x.valid_until) : '—'}</td>
                  <td className="nowrap muted small">{fmtDateTime(x.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
