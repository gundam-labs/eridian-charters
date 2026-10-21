import { useEffect, useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { normSettings } from '../../lib/normalize';
import { PageHead, ErrorAlert, Loading, OkAlert, Empty } from '../../components/ui';

const META = {
  gst_rate_pct: ['GST rate (%)', 'Applied to quote and invoice subtotals. Placeholder — confirm with accountant.'],
  night_halt_fee_inr: ['Night halt fee (INR)', 'Per night the aircraft is away from base between passenger legs.'],
  quote_validity_hours: ['Quote validity (hours)', 'Default validity once a quote is sent.'],
  invoice_due_days: ['Invoice due (days)', 'Days after issue.'],
  positioning_rate_pct: ['Positioning rate (%)', 'Percentage of hourly rate charged for positioning flights.'],
  taxi_allowance_hours: ['Taxi allowance (hours)', 'Added to every leg before rounding up to 0.1 h.'],
  manifest_cutoff_hours: ['Manifest cut-off (hours)', 'Hours before first departure the manifest is due.'],
  marketplace_commission_pct: ['Marketplace commission (%)', 'Taken from the fare of flights listed by operators, agents and flyers; the rest is paid out to them.'],
  lister_confirm_hours: ['Lister confirmation time (hours)', 'How long a lister has to confirm a paid request before it lapses and the hold is released.'],
  marketplace_checkout_minutes: ['Checkout time (minutes)', 'How long a traveller has to finish paying before the request is dropped.'],
  traveller_refund_72h_pct: ['Traveller refund > 72 h (%)', 'Refund when a traveller cancels a lister flight more than 72 hours before departure.'],
  traveller_refund_24h_pct: ['Traveller refund 24–72 h (%)', 'Refund when a traveller cancels 24–72 hours before departure (none within 24 hours).'],
};

export default function Settings() {
  const { data, error, loading, reload } = useFetch('/api/settings');
  const [f, setF] = useState({});
  const [initial, setInitial] = useState({});
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { const s = normSettings(data); setF(s); setInitial(s); }, [data]);
  const keys = Object.keys(f).sort((a, b) => (META[a] ? 0 : 1) - (META[b] ? 0 : 1) || a.localeCompare(b));
  const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => String(v) !== String(initial[k])));

  const save = async (e) => {
    e.preventDefault();
    if (!Object.keys(changed).length) return;
    setSaving(true); setErr(''); setOk('');
    try { await api.patch('/api/settings', changed); setOk('Settings saved.'); reload(); }
    catch (e2) { setErr(errText(e2)); } finally { setSaving(false); }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <PageHead eyebrow="Administration" title="Settings" sub="Pricing and operational defaults." />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : keys.length === 0 ? <div className="card"><Empty title="No settings" /></div> : (
        <form className="card card-pad" onSubmit={save}>
          <div className="stack">
            {keys.map(k => (
              <div className="field" key={k}>
                <label>{META[k]?.[0] || k}</label>
                <input className="input" value={f[k] ?? ''} onChange={e => setF(s => ({ ...s, [k]: e.target.value }))} />
                <span className="hint"><code>{k}</code>{META[k] ? ` — ${META[k][1]}` : ''}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}><ErrorAlert error={err} /><OkAlert>{ok}</OkAlert></div>
          <div className="form-actions"><button className="btn btn-primary" disabled={saving || !Object.keys(changed).length}>{saving ? 'Saving…' : `Save${Object.keys(changed).length ? ` (${Object.keys(changed).length})` : ''}`}</button></div>
        </form>
      )}
    </div>
  );
}
