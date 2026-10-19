import { useState } from 'react';
import api, { errText } from '../api';
import { Modal, ErrorAlert } from './ui';

export default function CancelModal({ title = 'Cancel charter', path, body, onClose, onDone, confirmLabel = 'Cancel charter', requireReason = true, warning }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (requireReason && !reason.trim()) { setError('Please give a reason.'); return; }
    setSaving(true); setError('');
    try {
      await api.post(path, { ...(body || {}), reason: reason.trim() || undefined });
      onDone?.();
    } catch (err) { setError(errText(err)); } finally { setSaving(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {warning && <div className="alert alert-warn">{warning}</div>}
        <div className="field">
          <label>Reason{requireReason ? '' : ' (optional)'}</label>
          <textarea className="textarea" value={reason} onChange={e => setReason(e.target.value)} autoFocus />
        </div>
        <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-danger" disabled={saving}>{saving ? 'Working…' : confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
