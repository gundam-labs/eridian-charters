import { useState } from 'react';
import api, { errText } from '../api';
import { ErrorAlert } from './ui';
import { toIstInput, istInputToIso } from '../lib/format';

/** Flight log entry: block off/on per passenger leg + defects. */
export default function FlightLogForm({ charter, onDone, compact }) {
  const legs = charter.legs || [];
  const [rows, setRows] = useState(() => legs.map(l => ({
    block_off: toIstInput(l.block_off || l.depart_at),
    block_on: toIstInput(l.block_on || l.arrive_at),
  })));
  const [defects, setDefects] = useState(charter.defects || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (i, patch) => setRows(rs => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const submit = async (e) => {
    e.preventDefault();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.block_off || !r.block_on) { setError(`Leg ${i + 1}: enter block off and block on.`); return; }
      if (new Date(istInputToIso(r.block_on)) <= new Date(istInputToIso(r.block_off))) { setError(`Leg ${i + 1}: block on must be after block off.`); return; }
    }
    setSaving(true); setError('');
    try {
      await api.post(`/api/charters/${charter.id}/flight-log`, {
        legs: rows.map((r, index) => ({ index, block_off: istInputToIso(r.block_off), block_on: istInputToIso(r.block_on) })),
        ...(defects.trim() ? { defects: defects.trim() } : {}),
      });
      onDone?.();
    } catch (err) {
      setError(errText(err));
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit}>
      {legs.map((l, i) => (
        <div className="pilot-leg" key={i}>
          <div className="hdr">
            <span className="rt">{l.from} → {l.to}</span>
            <span className="muted xs">Leg {i + 1}</span>
          </div>
          <div className={compact ? 'form-grid' : 'form-grid'}>
            <div className="field">
              <label>Block off (IST)</label>
              <input className="input" type="datetime-local" data-testid={`block-off-${i}`} required value={rows[i].block_off} onChange={e => set(i, { block_off: e.target.value })} />
            </div>
            <div className="field">
              <label>Block on (IST)</label>
              <input className="input" type="datetime-local" data-testid={`block-on-${i}`} required value={rows[i].block_on} onChange={e => set(i, { block_on: e.target.value })} />
            </div>
          </div>
        </div>
      ))}
      <div className="field" style={{ marginTop: 14 }}>
        <label>Defects / technical notes</label>
        <textarea className="textarea" value={defects} onChange={e => setDefects(e.target.value)} placeholder="Leave blank if none" />
      </div>
      <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
      <div className="form-actions">
        <button className="btn btn-primary btn-block" disabled={saving}>{saving ? 'Submitting…' : 'Submit flight log'}</button>
      </div>
    </form>
  );
}
