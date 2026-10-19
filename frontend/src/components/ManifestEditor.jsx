import { useEffect, useState } from 'react';
import api, { errText } from '../api';
import { ErrorAlert, OkAlert, Empty } from './ui';

const ID_TYPES = [
  ['passport', 'Passport'], ['aadhaar', 'Aadhaar'], ['driving_licence', 'Driving licence'], ['voter_id', 'Voter ID'], ['pan', 'PAN'],
];
const blank = () => ({ full_name: '', id_type: 'passport', id_number: '', nationality: 'Indian', phone: '' });

/**
 * Manifest editor. props: charter (normalised), canEdit, canSubmit, onChanged()
 */
export default function ManifestEditor({ charter, canEdit, canSubmit, onChanged }) {
  const seats = charter.seats || charter.aircraft_seats || charter.aircraft?.seats || null;
  const [rows, setRows] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const list = (charter.passengers || []).map(p => ({
      full_name: p.full_name || '', id_type: p.id_type || 'passport', id_number: p.id_number || '',
      nationality: p.nationality || 'Indian', phone: p.phone || '',
    }));
    setRows(list.length || !canEdit ? list : [blank()]);
    setDirty(false);
  }, [charter, canEdit]);

  const set = (i, patch) => { setRows(rs => rs.map((r, k) => (k === i ? { ...r, ...patch } : r))); setDirty(true); setOk(''); };
  const add = () => { setRows(rs => [...rs, blank()]); setDirty(true); };
  const remove = (i) => { setRows(rs => rs.filter((_, k) => k !== i)); setDirty(true); };

  const clean = () => rows
    .filter(r => r.full_name.trim() || r.id_number.trim())
    .map(r => ({
      full_name: r.full_name.trim(), id_type: r.id_type, id_number: r.id_number.trim(),
      nationality: r.nationality.trim() || 'Indian', ...(r.phone.trim() ? { phone: r.phone.trim() } : {}),
    }));

  const check = (list) => {
    for (let i = 0; i < list.length; i++) {
      if (!list[i].full_name || !list[i].id_type || !list[i].id_number) return `Passenger ${i + 1}: name, ID type and ID number are required.`;
    }
    if (seats && list.length > seats) return `This aircraft seats ${seats}; the manifest has ${list.length} passengers.`;
    return '';
  };

  const save = async () => {
    const list = clean();
    const v = check(list);
    if (v) { setError(v); return false; }
    setSaving(true); setError(''); setOk('');
    try {
      await api.put(`/api/charters/${charter.id}/passengers`, { passengers: list });
      setDirty(false); setOk('Manifest saved.');
      return true;
    } catch (e) {
      setError(errText(e)); return false;
    } finally { setSaving(false); }
  };

  const submit = async () => {
    const list = clean();
    if (!list.length) { setError('Add at least one passenger before submitting.'); return; }
    if (dirty || canEdit) {
      const saved = await save();
      if (!saved) return;
    }
    setSaving(true); setError('');
    try {
      await api.post(`/api/charters/${charter.id}/manifest/submit`);
      setOk('Manifest submitted. Thank you.');
      onChanged?.();
    } catch (e) {
      setError(errText(e));
    } finally { setSaving(false); }
  };

  const saveAndRefresh = async () => { if (await save()) onChanged?.(); };

  if (!canEdit) {
    const list = charter.passengers || [];
    return (
      <div className="card">
        <div className="card-head"><h2>Passenger manifest</h2><span className="muted xs">{list.length}{seats ? ` / ${seats} seats` : ''}</span></div>
        {ok && <div className="card-body" style={{ paddingBottom: 0 }}><OkAlert>{ok}</OkAlert></div>}
        {list.length === 0 ? <Empty title="No passengers yet">The manifest has not been entered.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Name</th><th>ID</th><th>Nationality</th><th>Phone</th></tr></thead>
              <tbody>
                {list.map((p, i) => (
                  <tr key={p.id || i}>
                    <td>{i + 1}</td><td className="strong">{p.full_name}</td>
                    <td className="nowrap">{labelFor(p.id_type)} <span className="mono">{p.id_number}</span></td>
                    <td>{p.nationality}</td><td>{p.phone || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Passenger manifest</h2>
        <span className="muted xs">{clean().length}{seats ? ` / ${seats} seats` : ''} · ID numbers are checked against identity documents at boarding</span>
      </div>
      <div className="card-body">
        {rows.length === 0 && <Empty title="No passengers yet">Add each traveller exactly as named on their ID.</Empty>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Full name</th><th>ID type</th><th>ID number</th><th>Nationality</th><th>Phone</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td style={{ minWidth: 170 }}><input className="input" data-testid={`pax-name-${i}`} value={r.full_name} onChange={e => set(i, { full_name: e.target.value })} placeholder="As on ID" /></td>
                    <td style={{ minWidth: 140 }}>
                      <select className="select" value={r.id_type} onChange={e => set(i, { id_type: e.target.value })}>
                        {ID_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                    <td style={{ minWidth: 150 }}><input className="input mono" data-testid={`pax-id-${i}`} value={r.id_number} onChange={e => set(i, { id_number: e.target.value })} /></td>
                    <td style={{ minWidth: 110 }}><input className="input" value={r.nationality} onChange={e => set(i, { nationality: e.target.value })} /></td>
                    <td style={{ minWidth: 130 }}><input className="input" value={r.phone} onChange={e => set(i, { phone: e.target.value })} placeholder="Optional" /></td>
                    <td><button type="button" className="btn btn-ghost btn-sm" title="Remove" onClick={() => remove(i)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={add} disabled={!!seats && rows.length >= seats}>+ Add passenger</button>
        </div>
        <div style={{ marginTop: 14 }}>
          <ErrorAlert error={error} />
          <OkAlert>{ok}</OkAlert>
          {canSubmit && charter.status === 'accepted' && (
            <div className="alert alert-info">You can save the manifest now; it can be submitted once operations confirm the flight.</div>
          )}
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={saveAndRefresh} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save manifest'}</button>
          {canSubmit && (
            <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || charter.status !== 'confirmed'}>
              {saving ? 'Working…' : 'Submit manifest'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function labelFor(t) {
  return (ID_TYPES.find(([v]) => v === t) || [t, t])[1];
}
