import { useEffect, useState } from 'react';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, StatusPill, OkAlert } from '../../components/ui';
import { ListerStatusBanner } from './ListerListings';
import { LISTER_TYPES } from '../Register';
import { fmtDate } from '../../lib/format';

const FIELDS = ['name', 'company', 'phone', 'city', 'gstin', 'nsop_permit_no', 'about'];

export default function ListerProfile() {
  const { data: me, error, loading, setData } = useFetch('/api/lister/me');
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    if (me) setF(Object.fromEntries(FIELDS.map(k => [k, me[k] || ''])));
  }, [me]);

  if (loading && !me) return <Loading />;
  if (!me || !f) return <ErrorAlert error={error || 'Could not load your profile'} />;

  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const type = LISTER_TYPES.find(t => t.value === me.lister_type);
  const locked = me.status === 'suspended';

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setErr(''); setOk('');
    try {
      const body = Object.fromEntries(FIELDS.filter(k => f[k] !== (me[k] || '')).map(k => [k, f[k]]));
      if (!Object.keys(body).length) { setOk('Nothing changed.'); return; }
      const r = await api.patch('/api/lister/me', body);
      setData(r.data);
      setOk(me.status === 'rejected' ? 'Saved — your account is back in our review queue.' : 'Profile saved.');
    } catch (e2) { setErr(errText(e2)); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHead eyebrow="Lister account" title="Profile"
        sub={<>{type?.label} · registered {fmtDate(me.created_at)} · <StatusPill status={me.status} /></>} />
      <ListerStatusBanner me={me} />
      <form className="card" style={{ padding: 24, maxWidth: 760 }} onSubmit={save}>
        <div className="form-grid">
          <div className="field"><label htmlFor="p-name">Your name</label>
            <input id="p-name" className="input" required disabled={locked} value={f.name} onChange={set('name')} /></div>
          <div className="field"><label>Email</label>
            <input className="input" disabled value={me.email} /><span className="hint">Contact us to change your sign-in email.</span></div>
          <div className="field"><label htmlFor="p-company">{me.lister_type === 'flyer' ? 'Company (optional)' : 'Company'}</label>
            <input id="p-company" className="input" disabled={locked} value={f.company} onChange={set('company')} /></div>
          <div className="field"><label htmlFor="p-phone">Mobile</label>
            <input id="p-phone" className="input" type="tel" required disabled={locked} value={f.phone} onChange={set('phone')} /></div>
          <div className="field"><label htmlFor="p-city">City</label>
            <input id="p-city" className="input" disabled={locked} value={f.city} onChange={set('city')} /></div>
          <div className="field"><label htmlFor="p-gstin">GSTIN</label>
            <input id="p-gstin" className="input" maxLength={15} disabled={locked} value={f.gstin} onChange={set('gstin')} style={{ textTransform: 'uppercase' }} /></div>
          {me.lister_type === 'operator' && (
            <div className="field span-2"><label htmlFor="p-nsop">DGCA NSOP permit number</label>
              <input id="p-nsop" className="input" required disabled={locked} value={f.nsop_permit_no} onChange={set('nsop_permit_no')} /></div>
          )}
          <div className="field span-2"><label htmlFor="p-about">About you <span className="muted">— seen by our team only</span></label>
            <textarea id="p-about" className="input" rows={3} disabled={locked} value={f.about} onChange={set('about')}
              placeholder="Fleet, bases, the routes you usually fly…" /></div>
        </div>
        <div style={{ marginTop: 14 }}><ErrorAlert error={err} /><OkAlert>{ok}</OkAlert></div>
        {!locked && (
          <div className="form-actions">
            <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : me.status === 'rejected' ? 'Save and resubmit' : 'Save profile'}</button>
          </div>
        )}
      </form>
    </>
  );
}
