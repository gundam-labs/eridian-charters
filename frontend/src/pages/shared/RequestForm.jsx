import { useMemo, useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { ErrorAlert } from '../../components/ui';
import { istInputToIso, toIstInput } from '../../lib/format';

const blankLeg = () => ({ from: '', to: '', depart_at: '' });

function nextMorning() {
  const d = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  return toIstInput(d).slice(0, 10) + 'T09:00';
}

/**
 * Multi-leg quote request form.
 * props: memberId (staff creating on behalf), onCreated(request)
 */
export default function RequestForm({ memberId, requireMember, onCreated }) {
  const { data: airports, error: apErr } = useFetch('/api/airports');
  const [legs, setLegs] = useState([{ from: '', to: '', depart_at: nextMorning() }]);
  const [pax, setPax] = useState(2);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const sorted = useMemo(
    () => (airports || []).slice().sort((a, b) => (a.city || a.code).localeCompare(b.city || b.code)),
    [airports]
  );

  const setLeg = (i, patch) => setLegs(ls => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const removeLeg = i => setLegs(ls => ls.filter((_, k) => k !== i));
  const swap = i => setLegs(ls => ls.map((l, k) => (k === i ? { ...l, from: l.to, to: l.from } : l)));

  const addLeg = () => setLegs(ls => {
    const last = ls[ls.length - 1];
    return [...ls, { from: last?.to || '', to: '', depart_at: '' }];
  });

  const addReturn = () => setLegs(ls => {
    const last = ls[ls.length - 1];
    const first = ls[0];
    // Return to the trip's origin, swapping from/to of the last leg
    let depart = '';
    if (last?.depart_at) {
      const d = new Date(istInputToIso(last.depart_at));
      d.setUTCDate(d.getUTCDate() + 1);
      depart = toIstInput(d).slice(0, 10) + 'T17:00';
    }
    return [...ls, { from: last?.to || '', to: ls.length === 1 ? last?.from || '' : first?.from || '', depart_at: depart }];
  });

  const validate = () => {
    if (requireMember && !memberId) return 'Choose the member this request is for.';
    if (!legs.length) return 'Add at least one leg.';
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      if (!l.from || !l.to || !l.depart_at) return `Leg ${i + 1}: choose from, to and departure time.`;
      if (l.from === l.to) return `Leg ${i + 1}: origin and destination must differ.`;
      if (new Date(istInputToIso(l.depart_at)) <= new Date()) return `Leg ${i + 1}: departure must be in the future.`;
      if (i > 0 && new Date(istInputToIso(l.depart_at)) <= new Date(istInputToIso(legs[i - 1].depart_at)))
        return `Leg ${i + 1}: departure must be after leg ${i}.`;
    }
    const p = Number(pax);
    if (!Number.isInteger(p) || p < 1 || p > 20) return 'Passengers must be between 1 and 20.';
    return '';
  };

  const submit = async (e) => {
    e.preventDefault();
    const v = validate();
    if (v) { setError(v); return; }
    setSaving(true); setError('');
    try {
      const body = { legs: legs.map(l => ({ from: l.from, to: l.to, depart_at: l.depart_at })), pax: Number(pax), notes };
      if (memberId) body.member_id = memberId;
      const r = await api.post('/api/quote-requests', body);
      onCreated?.(r.data?.request || r.data);
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const select = (val, onChange, label, testId) => (
    <div className="field">
      <label>{label}</label>
      <select className="select" data-testid={testId} value={val} onChange={e => onChange(e.target.value)} required>
        <option value="">Select airport</option>
        {sorted.map(a => <option key={a.code} value={a.code}>{a.city} — {a.code}</option>)}
      </select>
    </div>
  );

  return (
    <form onSubmit={submit}>
      <ErrorAlert error={apErr ? `Could not load airports: ${apErr}` : ''} />
      <div className="card">
        <div className="card-head">
          <h2>Itinerary</h2>
          <span className="muted xs">Times are local India time (IST) · up to 6 legs</span>
        </div>
        <div className="card-body">
          <div className="legs">
            {legs.map((l, i) => (
              <div className="leg-row" key={i}>
                <div className="leg-no">{i + 1}</div>
                {select(l.from, v => setLeg(i, { from: v }), 'From', `leg-from-${i}`)}
                <div className="leg-arrow">
                  <button type="button" className="btn btn-ghost btn-sm leg-swap" title="Swap from and to" onClick={() => swap(i)}>⇄</button>
                </div>
                {select(l.to, v => setLeg(i, { to: v }), 'To', `leg-to-${i}`)}
                <div className="field leg-when">
                  <label>Departure (IST)</label>
                  <input className="input" type="datetime-local" data-testid={`leg-depart-${i}`} required value={l.depart_at} onChange={e => setLeg(i, { depart_at: e.target.value })} />
                </div>
                <div className="leg-remove">
                  {legs.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-sm" title="Remove leg" onClick={() => removeLeg(i)}>✕</button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="actions" style={{ marginTop: 14 }}>
            <button type="button" className="btn" onClick={addLeg} disabled={legs.length >= 6}>+ Add leg</button>
            <button type="button" className="btn btn-gold" onClick={addReturn} disabled={legs.length >= 6 || !legs[legs.length - 1]?.to}>↩ Add return leg</button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label>Passengers</label>
              <input className="input" type="number" data-testid="pax-input" min={1} max={20} required value={pax} onChange={e => setPax(e.target.value)} />
              <span className="hint">We’ll match aircraft with enough seats.</span>
            </div>
            <div className="field span-2">
              <label>Notes for our charter team</label>
              <textarea className="textarea" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Catering, ground transport, flexibility on timings, pets…" />
            </div>
          </div>
          <ErrorAlert error={error} />
          <div className="form-actions">
            <button className="btn btn-primary" disabled={saving}>{saving ? 'Submitting…' : 'Submit request'}</button>
          </div>
        </div>
      </div>
    </form>
  );
}
