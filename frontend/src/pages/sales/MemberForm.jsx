import { useState } from 'react';
import api, { errText } from '../../api';
import { Modal, ErrorAlert } from '../../components/ui';

const FIELDS = ['member_type', 'contact_name', 'company', 'city', 'email', 'phone', 'gstin', 'tier', 'status', 'member_since', 'past_charters', 'notes'];

export default function MemberForm({ member, onClose, onSaved }) {
  const [f, setF] = useState(() => {
    const base = { member_type: 'individual', contact_name: '', company: '', city: '', email: '', phone: '', gstin: '', tier: 'silver', status: 'active', member_since: new Date().toISOString().slice(0, 7), past_charters: 0, notes: '' };
    if (member) FIELDS.forEach(k => { if (member[k] != null) base[k] = member[k]; });
    return base;
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    const body = { ...f, past_charters: Number(f.past_charters) || 0, company: f.company || null, gstin: f.gstin || null };
    try {
      const r = member ? await api.patch(`/api/members/${member.id}`, body) : await api.post('/api/members', body);
      onSaved(r.data?.member || r.data);
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };

  return (
    <Modal title={member ? `Edit ${member.member_no}` : 'New member'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field"><label>Type</label>
            <select className="select" value={f.member_type} onChange={set('member_type')}><option value="individual">Individual</option><option value="corporate">Corporate</option><option value="agent">Agent</option></select></div>
          <div className="field"><label>Tier</label>
            <select className="select" value={f.tier} onChange={set('tier')}><option value="silver">Silver</option><option value="gold">Gold</option><option value="platinum">Platinum</option></select></div>
          <div className="field"><label>Contact name</label><input className="input" required value={f.contact_name} onChange={set('contact_name')} /></div>
          <div className="field"><label>Company</label><input className="input" value={f.company || ''} onChange={set('company')} placeholder={f.member_type === 'individual' ? 'Optional' : ''} /></div>
          <div className="field"><label>Email</label><input className="input" type="email" required value={f.email} onChange={set('email')} /></div>
          <div className="field"><label>Phone</label><input className="input" required value={f.phone} onChange={set('phone')} placeholder="+91 …" /></div>
          <div className="field"><label>City</label><input className="input" required value={f.city} onChange={set('city')} /></div>
          <div className="field"><label>GSTIN</label><input className="input mono" value={f.gstin || ''} onChange={set('gstin')} placeholder="Optional — for tax invoices" /></div>
          <div className="field"><label>Member since</label><input className="input" type="month" value={f.member_since} onChange={set('member_since')} /></div>
          <div className="field"><label>Past charters</label><input className="input" type="number" min={0} value={f.past_charters} onChange={set('past_charters')} /></div>
          <div className="field"><label>Status</label>
            <select className="select" value={f.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
          <div className="field span-2"><label>Notes</label><textarea className="textarea" value={f.notes || ''} onChange={set('notes')} /></div>
        </div>
        <div style={{ marginTop: 14 }}><ErrorAlert error={error} /></div>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : member ? 'Save changes' : 'Create member'}</button></div>
      </form>
    </Modal>
  );
}
