import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, TierPill } from '../../components/ui';
import MemberForm from './MemberForm';

export default function Members() {
  const { user } = useAuth();
  const nav = useNavigate();
  const canEdit = ['sales', 'admin'].includes(user.role);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const qs = new URLSearchParams(Object.entries({ q, type, status }).filter(([, v]) => v)).toString();
  const { data, error, loading } = useFetch(`/api/members${qs ? `?${qs}` : ''}`);
  const list = data || [];

  return (
    <>
      <PageHead eyebrow="Clients" title="Members" sub={`${list.length} member${list.length === 1 ? '' : 's'}`}
        actions={canEdit && <button className="btn btn-primary" onClick={() => setCreating(true)}>New member</button>} />
      <div className="filters">
        <input className="input search" placeholder="Search name, company, email, member no" value={q} onChange={e => setQ(e.target.value)} />
        <select className="select" value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option><option value="individual">Individual</option><option value="corporate">Corporate</option><option value="agent">Agent</option>
        </select>
        <select className="select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </select>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No members found">{q || type || status ? 'Try a different search or filter.' : 'Create your first member to get started.'}</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Member</th><th>Name</th><th>Type</th><th>City</th><th>Tier</th><th className="num">Charters</th><th>Login</th><th>Status</th></tr></thead>
            <tbody>
              {list.map(m => (
                <tr key={m.id} className="clickable" onClick={() => nav(`/s/members/${m.id}`)}>
                  <td className="strong nowrap">{m.member_no}</td>
                  <td>{m.company || m.contact_name}{m.company && <div className="muted xs">{m.contact_name}</div>}<div className="muted xs">{m.email}</div></td>
                  <td style={{ textTransform: 'capitalize' }}>{m.member_type}</td>
                  <td>{m.city}</td>
                  <td><TierPill tier={m.tier} /></td>
                  <td className="num">{m.past_charters ?? 0}</td>
                  <td><StatusPill status={m.user_status || 'none'} label={m.user_status === 'none' || !m.user_status ? 'No login' : undefined} /></td>
                  <td><StatusPill status={m.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <MemberForm onClose={() => setCreating(false)} onSaved={m => { setCreating(false); nav(m?.id ? `/s/members/${m.id}` : '/s/members'); }} />}
    </>
  );
}
