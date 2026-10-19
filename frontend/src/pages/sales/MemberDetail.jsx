import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api, { errText } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { normMember } from '../../lib/normalize';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, TierPill, Modal, CopyField } from '../../components/ui';
import MemberForm from './MemberForm';
import { fmtDateTime, fmtDate, inr, route, aircraftReg } from '../../lib/format';

export default function MemberDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canEdit = ['sales', 'admin'].includes(user.role);
  const { data, error, loading, reload } = useFetch(`/api/members/${id}`);
  const m = normMember(data);
  const [editing, setEditing] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviting, setInviting] = useState(false);
  const [invErr, setInvErr] = useState('');

  const invite = async () => {
    setInviting(true); setInvErr('');
    try { const r = await api.post(`/api/members/${id}/invite`); setInviteUrl(r.data.invite_url); reload(); }
    catch (e) { setInvErr(errText(e)); } finally { setInviting(false); }
  };

  if (loading && !m) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  if (!m) return null;
  const login = m.users?.[0];

  return (
    <>
      <PageHead back={<Link to="/s/members" className="back">← Members</Link>} eyebrow={m.member_no}
        title={m.company || m.contact_name}
        sub={<>{m.company ? `${m.contact_name} · ` : ''}{m.city} · <TierPill tier={m.tier} /> <StatusPill status={m.status} /></>}
        actions={canEdit && <>
          <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn btn-gold" onClick={invite} disabled={inviting}>{inviting ? 'Sending…' : login ? 'Resend invite' : 'Send invite'}</button>
        </>} />
      <ErrorAlert error={invErr} />
      <div className="grid grid-side">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Recent charters</h2></div>
            {m.charters.length === 0 ? <Empty title="No charters yet" /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Charter</th><th>Dates</th><th>Route</th><th>Aircraft</th><th>Status</th></tr></thead>
                <tbody>{m.charters.map(c => (
                  <tr key={c.id}><td className="strong nowrap"><Link to={`/o/charters/${c.id}`}>{c.charter_no}</Link></td><td className="nowrap">{fmtDate(c.starts_on, { year: false })}</td><td className="nowrap">{route(c.legs)}</td><td>{aircraftReg(c)}</td><td><StatusPill status={c.status} /></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>Recent quotes</h2></div>
            {m.quotes.length === 0 ? <Empty title="No quotes yet" /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Quote</th><th>Created</th><th>Route</th><th className="num">Total</th><th>Status</th></tr></thead>
                <tbody>{m.quotes.map(q => (
                  <tr key={q.id}><td className="strong nowrap"><Link to={`/s/requests/${q.request_id}`}>{q.quote_no}</Link></td><td className="nowrap">{fmtDateTime(q.created_at)}</td><td className="nowrap">{route(q.legs)}</td><td className="num">{inr(q.total)}</td><td><StatusPill status={q.status} /></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </div>
        <div className="stack">
          <div className="card card-pad">
            <h3 style={{ marginBottom: 12 }}>Details</h3>
            <dl className="dl">
              <dt>Type</dt><dd style={{ textTransform: 'capitalize' }}>{m.member_type}</dd>
              <dt>Email</dt><dd style={{ wordBreak: 'break-all' }}>{m.email}</dd>
              <dt>Phone</dt><dd>{m.phone}</dd>
              <dt>GSTIN</dt><dd className="mono">{m.gstin || '—'}</dd>
              <dt>Member since</dt><dd>{m.member_since}</dd>
              <dt>Past charters</dt><dd>{m.past_charters}</dd>
            </dl>
            {m.notes && <p className="small" style={{ marginTop: 12 }}>{m.notes}</p>}
          </div>
          <div className="card card-pad">
            <h3 style={{ marginBottom: 12 }}>Portal access</h3>
            {(m.users || []).length === 0 ? <p className="small muted">No login yet. Send an invite to give this member access to the portal.</p> : m.users.map(u => (
              <dl className="dl" key={u.id}>
                <dt>Login</dt><dd style={{ wordBreak: 'break-all' }}>{u.email}</dd>
                <dt>Active</dt><dd>{u.is_active === false ? 'Deactivated' : 'Yes'}</dd>
                <dt>Last login</dt><dd>{u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never (invite pending)'}</dd>
              </dl>
            ))}
          </div>
        </div>
      </div>
      {editing && <MemberForm member={m} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {inviteUrl && <InviteLinkModal url={inviteUrl} email={m.email} onClose={() => setInviteUrl('')} />}
    </>
  );
}

export function InviteLinkModal({ url, email, onClose }) {
  return (
    <Modal title="Invitation sent" onClose={onClose}>
      <p className="small">An email with this link was sent to <strong>{email}</strong>. You can also share it directly — it expires in 72 hours.</p>
      <CopyField value={url} />
      <div className="form-actions"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
