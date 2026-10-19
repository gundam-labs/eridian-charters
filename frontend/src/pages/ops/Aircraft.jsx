import { useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal, StatusPill } from '../../components/ui';
import { inr } from '../../lib/format';

export default function Aircraft() {
  const { data, error, loading, reload } = useFetch('/api/aircraft');
  const { data: airports } = useFetch('/api/airports');
  const [editing, setEditing] = useState(null);
  const list = (data || []).slice().sort((a, b) => String(a.registration).localeCompare(b.registration));
  return (
    <>
      <PageHead eyebrow="Operations" title="Aircraft" sub={`${list.length} aircraft · ${list.filter(a => a.status === 'active').length} active`} actions={<button className="btn btn-primary" onClick={() => setEditing({})}>Add aircraft</button>} />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No aircraft">Add the partner-owned aircraft you operate.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Registration</th><th>Type</th><th className="num">Seats</th><th>Base</th><th className="num">Cruise</th><th className="num">Hourly rate</th><th>Partner</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.map(a => (
                <tr key={a.id}>
                  <td className="strong nowrap">{a.registration}</td><td>{a.type}</td><td className="num">{a.seats}</td><td>{a.home_base}</td>
                  <td className="num nowrap">{a.cruise_speed_kts} kts</td><td className="num nowrap">{inr(a.hourly_rate_inr)}</td><td className="small">{a.partner_name}</td>
                  <td><StatusPill status={a.status} /></td>
                  <td className="right"><button className="btn btn-sm" onClick={() => setEditing(a)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <AircraftForm ac={editing.id ? editing : null} airports={airports || []} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function AircraftForm({ ac, airports, onClose, onDone }) {
  const [f, setF] = useState({
    registration: ac?.registration || 'VT-', type: ac?.type || '', seats: ac?.seats ?? 10, home_base: ac?.home_base || '',
    cruise_speed_kts: ac?.cruise_speed_kts ?? 450, hourly_rate_inr: ac?.hourly_rate_inr ?? '', partner_name: ac?.partner_name || '',
    status: ac?.status || 'active', notes: ac?.notes || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    const body = { ...f, registration: f.registration.toUpperCase().trim(), seats: Number(f.seats), cruise_speed_kts: Number(f.cruise_speed_kts), hourly_rate_inr: Number(f.hourly_rate_inr) };
    try { ac ? await api.patch(`/api/aircraft/${ac.id}`, body) : await api.post('/api/aircraft', body); onDone(); }
    catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };
  return (
    <Modal title={ac ? `Edit ${ac.registration}` : 'Add aircraft'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field"><label>Registration</label><input className="input mono" required value={f.registration} onChange={set('registration')} /></div>
          <div className="field"><label>Type</label><input className="input" required list="ac-types" value={f.type} onChange={set('type')} />
            <datalist id="ac-types"><option value="Bombardier Challenger 350" /><option value="Embraer Praetor 600" /><option value="Gulfstream G280" /></datalist></div>
          <div className="field"><label>Seats</label><input className="input" type="number" min={1} max={20} required value={f.seats} onChange={set('seats')} /></div>
          <div className="field"><label>Home base</label>
            <select className="select" required value={f.home_base} onChange={set('home_base')}><option value="">Select</option>{airports.map(a => <option key={a.code} value={a.code}>{a.code} · {a.city}</option>)}</select></div>
          <div className="field"><label>Cruise speed (kts)</label><input className="input" type="number" min={100} required value={f.cruise_speed_kts} onChange={set('cruise_speed_kts')} /></div>
          <div className="field"><label>Hourly rate (INR)</label><input className="input" type="number" min={0} required value={f.hourly_rate_inr} onChange={set('hourly_rate_inr')} /></div>
          <div className="field"><label>Partner (owner)</label><input className="input" required value={f.partner_name} onChange={set('partner_name')} /></div>
          <div className="field"><label>Status</label><select className="select" value={f.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
          <div className="field span-2"><label>Notes</label><textarea className="textarea" value={f.notes} onChange={set('notes')} /></div>
        </div>
        <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Modal>
  );
}
