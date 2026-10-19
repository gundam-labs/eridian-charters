import { useState } from 'react';
import api, { errText } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal, StatusPill, RolePill } from '../../components/ui';
import { InviteLinkModal } from '../sales/MemberDetail';
import { fmtDateTime } from '../../lib/format';

const STAFF_ROLES = ['admin', 'sales', 'ops', 'pilot'];

export default function Users() {
  const { user: me } = useAuth();
  const { data, error, loading, reload } = useFetch('/api/users');
  const [role, setRole] = useState('');
  const [editing, setEditing] = useState(null);
  const [invite, setInvite] = useState(null);
  const [busy, setBusy] = useState('');
  const [actErr, setActErr] = useState('');
  const list = (data || []).filter(u => !role || u.role === role).sort((a, b) => a.role.localeCompare(b.role) || a.email.localeCompare(b.email));

  const reinvite = async (u) => {
    setBusy(u.id); setActErr('');
    try { const r = await api.post(`/api/users/${u.id}/invite`); setInvite({ url: r.data.invite_url, email: u.email }); }
    catch (e) { setActErr(errText(e)); } finally { setBusy(''); }
  };
  const toggle = async (u) => {
    if (u.is_active && !window.confirm(`Deactivate ${u.email}? They will no longer be able to sign in.`)) return;
    setBusy(u.id); setActErr('');
    try { await api.patch(`/api/users/${u.id}`, { is_active: !u.is_active }); reload(); }
    catch (e) { setActErr(errText(e)); } finally { setBusy(''); }
  };

  return (
    <>
      <PageHead eyebrow="Administration" title="Users" actions={<button className="btn btn-primary" onClick={() => setEditing({})}>Add staff user</button>} />
      <div className="filters">
        <select className="select" value={role} onChange={e => setRole(e.target.value)}>
          <option value="">All roles</option>{[...STAFF_ROLES, 'member'].map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <ErrorAlert error={error || actErr} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No users">Add staff users to give them access.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last login</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.map(u => (
                <tr key={u.id}>
                  <td className="strong">{u.name}{u.member_no && <div className="muted xs">{u.member_no}</div>}</td>
                  <td className="small">{u.email}</td>
                  <td><RolePill role={u.role} /></td>
                  <td className="small nowrap">{u.last_login_at ? fmtDateTime(u.last_login_at) : <span className="muted">Never</span>}</td>
                  <td><StatusPill status={u.is_active === false ? 'inactive' : 'active'} /></td>
                  <td className="right nowrap">
                    <div className="actions" style={{ justifyContent: 'flex-end' }}>
                      {u.role !== 'member' && <button className="btn btn-sm" onClick={() => setEditing(u)}>Edit</button>}
                      <button className="btn btn-sm" onClick={() => reinvite(u)} disabled={busy === u.id}>Invite link</button>
                      {u.id !== me.id && <button className={`btn btn-sm ${u.is_active === false ? '' : 'btn-danger'}`} onClick={() => toggle(u)} disabled={busy === u.id}>{u.is_active === false ? 'Reactivate' : 'Deactivate'}</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <UserForm u={editing.id ? editing : null} onClose={() => setEditing(null)}
        onDone={(inv) => { setEditing(null); reload(); if (inv) setInvite(inv); }} />}
      {invite && <InviteLinkModal url={invite.url} email={invite.email} onClose={() => setInvite(null)} />}
    </>
  );
}

function UserForm({ u, onClose, onDone }) {
  const [f, setF] = useState({ email: u?.email || '', name: u?.name || '', role: u?.role || 'sales' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (u) { await api.patch(`/api/users/${u.id}`, { name: f.name, role: f.role }); onDone(); }
      else { const r = await api.post('/api/users', f); onDone(r.data?.invite_url ? { url: r.data.invite_url, email: f.email } : null); }
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };
  return (
    <Modal title={u ? `Edit ${u.email}` : 'Add staff user'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field span-2"><label>Name</label><input className="input" required value={f.name} onChange={set('name')} /></div>
          <div className="field"><label>Email</label><input className="input" type="email" required disabled={!!u} value={f.email} onChange={set('email')} /></div>
          <div className="field"><label>Role</label><select className="select" value={f.role} onChange={set('role')}>{STAFF_ROLES.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
        </div>
        {!u && <p className="hint" style={{ marginTop: 10 }}>An invitation link is emailed and shown to you after saving. For pilots, link the login to their crew record under Crew.</p>}
        <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : u ? 'Save' : 'Create & invite'}</button></div>
      </form>
    </Modal>
  );
}
