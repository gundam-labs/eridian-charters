import { useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal, StatusPill } from '../../components/ui';
import { humanize } from '../../lib/format';

export default function Crew() {
  const { data, error, loading, reload } = useFetch('/api/crew');
  const { data: airports } = useFetch('/api/airports');
  const [role, setRole] = useState('');
  const [editing, setEditing] = useState(null);
  const list = (data || []).filter(c => !role || c.crew_role === role).sort((a, b) => a.crew_role.localeCompare(b.crew_role) || a.name.localeCompare(b.name));

  return (
    <>
      <PageHead eyebrow="Operations" title="Crew" sub={`${(data || []).length} crew members`} actions={<button className="btn btn-primary" onClick={() => setEditing({})}>Add crew member</button>} />
      <div className="filters">
        <select className="select" value={role} onChange={e => setRole(e.target.value)}>
          <option value="">All roles</option><option value="captain">Captains</option><option value="first_officer">First officers</option><option value="cabin_crew">Cabin crew</option>
        </select>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No crew">Add captains, first officers and cabin crew.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Base</th><th>Licence</th><th>Pilot login</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.map(c => (
                <tr key={c.id}>
                  <td className="strong">{c.name}</td>
                  <td>{humanize(c.crew_role)}</td>
                  <td>{c.base}</td>
                  <td className="mono small">{c.licence_no || '—'}</td>
                  <td className="small">{c.user_email || (c.user_id ? 'Linked' : '—')}</td>
                  <td><StatusPill status={c.is_active === false ? 'inactive' : 'active'} /></td>
                  <td className="right"><button className="btn btn-sm" onClick={() => setEditing(c)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CrewForm crew={editing.id ? editing : null} airports={airports || []} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function CrewForm({ crew, airports, onClose, onDone }) {
  const { data: users } = useFetch('/api/users');
  const pilots = (users || []).filter(u => u.role === 'pilot');
  const [f, setF] = useState({
    name: crew?.name || '', crew_role: crew?.crew_role || 'captain', base: crew?.base || '',
    licence_no: crew?.licence_no || '', user_id: crew?.user_id || '', is_active: crew?.is_active !== false,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    const body = { ...f, licence_no: f.licence_no || null, user_id: f.user_id || null };
    try { crew ? await api.patch(`/api/crew/${crew.id}`, body) : await api.post('/api/crew', body); onDone(); }
    catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };
  return (
    <Modal title={crew ? `Edit ${crew.name}` : 'Add crew member'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field span-2"><label>Name</label><input className="input" required value={f.name} onChange={set('name')} /></div>
          <div className="field"><label>Role</label>
            <select className="select" value={f.crew_role} onChange={set('crew_role')}><option value="captain">Captain</option><option value="first_officer">First officer</option><option value="cabin_crew">Cabin crew</option></select></div>
          <div className="field"><label>Base</label>
            <select className="select" required value={f.base} onChange={set('base')}><option value="">Select</option>{airports.map(a => <option key={a.code} value={a.code}>{a.code} · {a.city}</option>)}</select></div>
          <div className="field"><label>Licence no.</label><input className="input mono" value={f.licence_no} onChange={set('licence_no')} /></div>
          {users && f.crew_role !== 'cabin_crew' && (
            <div className="field"><label>Pilot login</label>
              <select className="select" value={f.user_id} onChange={set('user_id')}><option value="">None</option>{pilots.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}</select></div>
          )}
          <label className="check span-2"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} /> Active</label>
        </div>
        <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Modal>
  );
}
