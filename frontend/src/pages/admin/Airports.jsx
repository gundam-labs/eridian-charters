import { useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal } from '../../components/ui';
import { inr } from '../../lib/format';

export default function Airports() {
  const { data, error, loading, reload } = useFetch('/api/airports');
  const [editing, setEditing] = useState(null);
  const list = (data || []).slice().sort((a, b) => a.code.localeCompare(b.code));
  return (
    <>
      <PageHead eyebrow="Administration" title="Airports" sub="Coordinates drive distance calculation; fees feed every quote." actions={<button className="btn btn-primary" onClick={() => setEditing({})}>Add airport</button>} />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No airports">Add the airports you operate to.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>City</th><th className="num">Lat</th><th className="num">Lon</th><th className="num">Landing fee</th><th className="num">Handling fee</th><th /></tr></thead>
            <tbody>
              {list.map(a => (
                <tr key={a.code}>
                  <td className="strong">{a.code}</td><td>{a.name}</td><td>{a.city}</td>
                  <td className="num">{Number(a.lat).toFixed(4)}</td><td className="num">{Number(a.lon).toFixed(4)}</td>
                  <td className="num">{inr(a.landing_fee_inr)}</td><td className="num">{inr(a.handling_fee_inr)}</td>
                  <td className="right"><button className="btn btn-sm" onClick={() => setEditing(a)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <AirportForm ap={editing.code ? editing : null} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function AirportForm({ ap, onClose, onDone }) {
  const [f, setF] = useState({
    code: ap?.code || '', name: ap?.name || '', city: ap?.city || '', lat: ap?.lat ?? '', lon: ap?.lon ?? '',
    landing_fee_inr: ap?.landing_fee_inr ?? '', handling_fee_inr: ap?.handling_fee_inr ?? '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    const body = { ...f, code: f.code.toUpperCase().trim(), lat: Number(f.lat), lon: Number(f.lon), landing_fee_inr: Number(f.landing_fee_inr), handling_fee_inr: Number(f.handling_fee_inr) };
    try {
      if (ap) { const { code, ...rest } = body; await api.patch(`/api/airports/${ap.code}`, rest); } // eslint-disable-line no-unused-vars
      else await api.post('/api/airports', body);
      onDone();
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };
  return (
    <Modal title={ap ? `Edit ${ap.code}` : 'Add airport'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field"><label>IATA code</label><input className="input mono" required maxLength={3} disabled={!!ap} value={f.code} onChange={set('code')} /></div>
          <div className="field"><label>City</label><input className="input" required value={f.city} onChange={set('city')} /></div>
          <div className="field span-2"><label>Name</label><input className="input" required value={f.name} onChange={set('name')} /></div>
          <div className="field"><label>Latitude</label><input className="input" type="number" step="any" required value={f.lat} onChange={set('lat')} /></div>
          <div className="field"><label>Longitude</label><input className="input" type="number" step="any" required value={f.lon} onChange={set('lon')} /></div>
          <div className="field"><label>Landing fee (INR)</label><input className="input" type="number" min={0} required value={f.landing_fee_inr} onChange={set('landing_fee_inr')} /></div>
          <div className="field"><label>Handling fee (INR)</label><input className="input" type="number" min={0} required value={f.handling_fee_inr} onChange={set('handling_fee_inr')} /></div>
        </div>
        <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Modal>
  );
}
