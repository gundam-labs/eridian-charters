import { useState } from 'react';
import { Link } from 'react-router-dom';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, Modal, Toast } from '../../components/ui';
import CancelModal from '../../components/CancelModal';
import { fmtDate, fmtDateTime, humanize } from '../../lib/format';
import { LISTER_TYPES } from '../Register';

const typeLabel = (t) => LISTER_TYPES.find(x => x.value === t)?.label || humanize(t);

export default function Listers() {
  const [status, setStatus] = useState('pending');
  const { data, error, loading, reload } = useFetch(`/api/listers${status ? `?status=${status}` : ''}`);
  const [open, setOpen] = useState(null);
  const [acting, setActing] = useState(null); // { lister, action: 'reject' | 'suspend' }
  const [toast, setToast] = useState('');
  const list = Array.isArray(data) ? data : [];

  const done = (msg) => { setOpen(null); setActing(null); setToast(msg); reload(); };

  return (
    <>
      <PageHead eyebrow="Marketplace" title="Listers"
        sub="Charter operators, travel agents and private flyers who signed up to post empty legs. Approve them before their listings can go live."
        actions={<Link className="btn" to="/s/empty-legs">Empty legs</Link>} />
      <div className="filters">
        <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">All listers</option>
          {['pending', 'approved', 'rejected', 'suspended'].map(s => <option key={s} value={s}>{s === 'pending' ? 'Waiting for review' : humanize(s)}</option>)}
        </select>
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title={status === 'pending' ? 'No one waiting for review' : 'No listers'}>
          New sign-ups from the “List your empty leg” page appear here, and we email sales and admin.
        </Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Lister</th><th>Type</th><th>Contact</th><th className="num">Listings</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.map(l => (
                <tr key={l.id}>
                  <td><button className="link-btn strong" onClick={() => setOpen(l)}>{l.company || l.name}</button>
                    <div className="muted xs">{l.company ? `${l.name} · ` : ''}joined {fmtDate(l.created_at)}</div></td>
                  <td className="nowrap">{typeLabel(l.lister_type)}{l.nsop_permit_no && <div className="muted xs">{l.nsop_permit_no}
                    {l.lister_type === 'operator' && (l.dgca_operator
                      ? <span title={l.dgca_operator.name} style={{ color: 'var(--green-fg)' }}> · in DGCA list</span>
                      : <span style={{ color: 'var(--amber-fg)' }}> · not in DGCA list</span>)}</div>}</td>
                  <td><div className="xs">{l.email}</div><div className="muted xs">{l.phone}{l.city ? ` · ${l.city}` : ''}</div></td>
                  <td className="num nowrap">{l.listings_count}<div className="muted xs">{l.live_count} live · {l.booked_count} booked</div></td>
                  <td><StatusPill status={l.status} label={l.status === 'pending' ? 'To review' : undefined} /></td>
                  <td className="right nowrap">
                    <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      {l.status === 'pending' && <button className="btn btn-sm btn-gold" onClick={() => setOpen(l)}>Review</button>}
                      {l.status === 'approved' && <button className="btn btn-sm btn-danger" onClick={() => setActing({ lister: l, action: 'suspend' })}>Suspend</button>}
                      {['rejected', 'suspended'].includes(l.status) && <button className="btn btn-sm" onClick={() => setOpen(l)}>View</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <ReviewModal lister={open} onClose={() => setOpen(null)}
        onApproved={() => done(`${open.company || open.name} approved`)}
        onReject={() => { setActing({ lister: open, action: 'reject' }); setOpen(null); }} />}
      {acting && (
        <CancelModal
          title={`${acting.action === 'reject' ? 'Reject' : 'Suspend'} ${acting.lister.company || acting.lister.name}`}
          confirmLabel={acting.action === 'reject' ? 'Reject registration' : 'Suspend lister'}
          path={`/api/listers/${acting.lister.id}/${acting.action}`}
          warning={acting.action === 'reject'
            ? 'They are emailed your reason and can update their details to be reviewed again.'
            : 'All their open listings are withdrawn now and anyone with a pending request is told the flight was withdrawn. They are emailed your reason.'}
          onClose={() => setActing(null)}
          onDone={() => done(acting.action === 'reject' ? 'Registration rejected' : 'Lister suspended')} />
      )}
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function ReviewModal({ lister: l, onClose, onApproved, onReject }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const canApprove = ['pending', 'rejected', 'suspended'].includes(l.status);

  const approve = async () => {
    setSaving(true); setError('');
    try { await api.post(`/api/listers/${l.id}/approve`); onApproved(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  };

  return (
    <Modal title={l.company || l.name} onClose={onClose}>
      <dl className="dl">
        <dt>Type</dt><dd>{typeLabel(l.lister_type)}</dd>
        <dt>Contact</dt><dd>{l.name} · {l.email} · {l.phone}</dd>
        {l.city && <><dt>City</dt><dd>{l.city}</dd></>}
        {l.nsop_permit_no && <><dt>NSOP permit</dt><dd>{l.nsop_permit_no}</dd></>}
        {l.lister_type === 'operator' && <><dt>DGCA list</dt><dd>{l.dgca_operator
          ? <><span className="pill pill-green">Match</span>{' '}
            <Link to={`/admin/operators?op=${l.dgca_operator.id}`}>{l.dgca_operator.name}</Link>
            <span className="muted small"> · AOP {l.dgca_operator.aop_no}, valid to {fmtDate(l.dgca_operator.aop_valid_until)}</span></>
          : <><span className="pill pill-amber">No match</span> <span className="muted small">No operator in the DGCA list has this permit number.</span></>}</dd></>}
        <dt>PAN</dt><dd>{l.pan || <span className="muted">Not given</span>}</dd>
        {l.tan && <><dt>TAN</dt><dd>{l.tan}</dd></>}
        {l.gstin && <><dt>GSTIN</dt><dd>{l.gstin}</dd></>}
        {l.about && <><dt>About</dt><dd>{l.about}</dd></>}
        <dt>Registered</dt><dd>{fmtDateTime(l.created_at)}</dd>
        <dt>Status</dt><dd><StatusPill status={l.status} />{l.decision_reason ? <span className="muted small"> — {l.decision_reason}</span> : null}</dd>
        {l.decided_by_name && <><dt>Decided by</dt><dd>{l.decided_by_name}, {fmtDateTime(l.decided_at)}</dd></>}
      </dl>
      {l.lister_type === 'operator' && l.status === 'pending' && !l.dgca_operator && (
        <div className="alert alert-warn" style={{ marginTop: 16 }}>
          The permit number doesn’t match the DGCA list we hold. Check it with the operator before approving.
        </div>
      )}
      <ErrorAlert error={error} />
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>Close</button>
        {l.status === 'pending' && <button type="button" className="btn btn-danger" onClick={onReject}>Reject</button>}
        {canApprove && <button type="button" className="btn btn-gold" disabled={saving} onClick={approve}>
          {saving ? 'Approving…' : l.status === 'suspended' ? 'Reinstate' : 'Approve'}</button>}
      </div>
    </Modal>
  );
}
