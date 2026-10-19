import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal } from '../../components/ui';
import { fmtDate, istDate } from '../../lib/format';

export default function Maintenance() {
  const [params] = useSearchParams();
  const [acFilter, setAcFilter] = useState('');
  const { data, error, loading, reload } = useFetch(`/api/maintenance${acFilter ? `?aircraft_id=${acFilter}` : ''}`);
  const { data: aircraft } = useFetch('/api/aircraft');
  const [adding, setAdding] = useState(!!params.get('aircraft_id'));
  const [delErr, setDelErr] = useState('');
  const [deleting, setDeleting] = useState('');
  const today = istDate();
  const acById = Object.fromEntries((aircraft || []).map(a => [a.id, a]));
  const list = (data || []).slice().sort((a, b) => String(b.starts_on).localeCompare(String(a.starts_on)));

  const remove = async (m) => {
    if (!window.confirm('Delete this maintenance block?')) return;
    setDeleting(m.id); setDelErr('');
    try { await api.delete(`/api/maintenance/${m.id}`); reload(); } catch (e) { setDelErr(errText(e)); } finally { setDeleting(''); }
  };

  return (
    <>
      <PageHead eyebrow="Operations" title="Maintenance" actions={<button className="btn btn-primary" onClick={() => setAdding(true)}>Add block</button>} />
      <div className="filters">
        <select className="select" value={acFilter} onChange={e => setAcFilter(e.target.value)}>
          <option value="">All aircraft</option>
          {(aircraft || []).map(a => <option key={a.id} value={a.id}>{a.registration}</option>)}
        </select>
      </div>
      <ErrorAlert error={error || delErr} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No maintenance blocks" action={<button className="btn btn-primary" onClick={() => setAdding(true)}>Add block</button>}>Scheduled maintenance makes an aircraft unavailable for quoting.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Aircraft</th><th>From</th><th>To (inclusive)</th><th>Reason</th><th>State</th><th /></tr></thead>
            <tbody>
              {list.map(m => {
                const st = m.ends_on < today ? 'Past' : m.starts_on <= today ? 'In progress' : 'Scheduled';
                return (
                  <tr key={m.id}>
                    <td className="strong nowrap">{m.registration || acById[m.aircraft_id]?.registration || '—'}</td>
                    <td className="nowrap">{fmtDate(m.starts_on)}</td>
                    <td className="nowrap">{fmtDate(m.ends_on)}</td>
                    <td>{m.reason}</td>
                    <td><span className={`pill ${st === 'In progress' ? 'pill-amber' : st === 'Scheduled' ? 'pill-blue' : 'pill-grey'}`}>{st}</span></td>
                    <td className="right"><button className="btn btn-sm btn-danger" onClick={() => remove(m)} disabled={deleting === m.id}>{deleting === m.id ? 'Deleting…' : 'Delete'}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddBlock aircraft={aircraft || []} initialAircraft={params.get('aircraft_id')} initialDate={params.get('date')}
        onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function AddBlock({ aircraft, initialAircraft, initialDate, onClose, onDone }) {
  const [f, setF] = useState({ aircraft_id: initialAircraft || '', starts_on: initialDate || istDate(), ends_on: initialDate || istDate(), reason: '' });
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  const submit = async (e, force) => {
    e?.preventDefault();
    if (f.ends_on < f.starts_on) { setError('End date must be on or after the start date.'); return; }
    setSaving(true); setError('');
    try {
      await api.post('/api/maintenance', { ...f, ...(force ? { force: true } : {}) });
      onDone();
    } catch (err) {
      setError(errText(err));
      setConflict(err.response?.status === 409);
    } finally { setSaving(false); }
  };

  return (
    <Modal title="Add maintenance block" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field span-2"><label>Aircraft</label>
            <select className="select" required value={f.aircraft_id} onChange={set('aircraft_id')}>
              <option value="">Select aircraft</option>
              {aircraft.map(a => <option key={a.id} value={a.id}>{a.registration} · {a.type}</option>)}
            </select></div>
          <div className="field"><label>From</label><input className="input" type="date" required value={f.starts_on} onChange={set('starts_on')} /></div>
          <div className="field"><label>To (inclusive)</label><input className="input" type="date" required value={f.ends_on} onChange={set('ends_on')} /></div>
          <div className="field span-2"><label>Reason</label><input className="input" required value={f.reason} onChange={set('reason')} placeholder="e.g. A-check, avionics upgrade" /></div>
        </div>
        <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {conflict && <button type="button" className="btn btn-danger" disabled={saving} onClick={() => submit(null, true)}>Save anyway</button>}
          <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Add block'}</button>
        </div>
      </form>
    </Modal>
  );
}
