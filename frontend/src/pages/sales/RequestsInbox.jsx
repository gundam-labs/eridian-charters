import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, Modal } from '../../components/ui';
import RequestForm from '../shared/RequestForm';
import { fmtDateTime, route, memberName } from '../../lib/format';

const ORDER = { open: 0, quoted: 1, closed: 2, cancelled: 3 };

export default function RequestsInbox() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const { data, error, loading } = useFetch(`/api/quote-requests${status ? `?status=${status}` : ''}`);
  const list = useMemo(() => (data || []).slice().sort((a, b) =>
    (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
    new Date(a.legs?.[0]?.depart_at || 0) - new Date(b.legs?.[0]?.depart_at || 0)), [data]);

  return (
    <>
      <PageHead eyebrow="Sales" title="Requests inbox" sub="Open requests first, soonest departure at the top."
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)}>New request for member</button>} />
      <div className="filters">
        <select className="select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="open">Open</option><option value="quoted">Quoted</option><option value="closed">Closed</option><option value="cancelled">Cancelled</option>
        </select>
      </div>
      <ErrorAlert error={error} />
      {loading ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="Inbox clear">No quote requests match this filter.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Request</th><th>Member</th><th>Route</th><th>First departure</th><th className="num">Pax</th><th className="num">Quotes</th><th>Status</th><th>Received</th></tr></thead>
            <tbody>
              {list.map(r => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/s/requests/${r.id}`)}>
                  <td className="strong nowrap"><Link to={`/s/requests/${r.id}`}>{r.request_no}</Link></td>
                  <td>{memberName(r)}{r.member_no && <div className="muted xs">{r.member_no}</div>}</td>
                  <td className="nowrap">{route(r.legs)}</td>
                  <td className="nowrap">{fmtDateTime(r.legs?.[0]?.depart_at)}</td>
                  <td className="num">{r.pax}</td>
                  <td className="num">{r.quote_count ?? '—'}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td className="nowrap muted">{fmtDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewRequestModal onClose={() => setCreating(false)} onCreated={r => nav(r?.id ? `/s/requests/${r.id}` : '/s/requests')} />}
    </>
  );
}

function NewRequestModal({ onClose, onCreated }) {
  const { data: members } = useFetch('/api/members?status=active');
  const [memberId, setMemberId] = useState('');
  return (
    <Modal title="New request on behalf of a member" onClose={onClose} wide>
      <div className="field" style={{ marginBottom: 16 }}>
        <label>Member</label>
        <select className="select" value={memberId} onChange={e => setMemberId(e.target.value)}>
          <option value="">Select member</option>
          {(members || []).map(m => <option key={m.id} value={m.id}>{m.member_no} · {m.company || m.contact_name}</option>)}
        </select>
      </div>
      <RequestForm memberId={memberId} requireMember onCreated={onCreated} />
    </Modal>
  );
}
