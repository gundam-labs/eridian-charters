import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import api, { errText } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../lib/useFetch';
import { normMember } from '../../lib/normalize';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, TierPill, Modal, CopyField, CopyButton, OkAlert } from '../../components/ui';
import { getPaymentsConfig, invoiceMoney, isPayable } from '../../lib/payments';
import MemberForm from './MemberForm';
import { fmtDateTime, fmtDate, inr, route, aircraftReg } from '../../lib/format';

export default function MemberDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canEdit = ['sales', 'admin'].includes(user.role);
  const { data, error, loading, reload } = useFetch(`/api/members/${id}`);
  const m = normMember(data);
  const [editing, setEditing] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviting, setInviting] = useState(false);
  const [invErr, setInvErr] = useState('');

  const invite = async () => {
    setInviting(true); setInvErr('');
    try { const r = await api.post(`/api/members/${id}/invite`); setInviteUrl(r.data.invite_url); reload(); }
    catch (e) { setInvErr(errText(e)); } finally { setInviting(false); }
  };

  if (loading && !m) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  if (!m) return null;
  const login = m.users?.[0];

  return (
    <>
      <PageHead back={<Link to="/s/members" className="back">← Members</Link>} eyebrow={m.member_no}
        title={m.company || m.contact_name}
        sub={<>{m.company ? `${m.contact_name} · ` : ''}{m.city} · <TierPill tier={m.tier} /> <StatusPill status={m.status} /></>}
        actions={canEdit && <>
          <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn btn-gold" onClick={invite} disabled={inviting}>{inviting ? 'Sending…' : login ? 'Resend invite' : 'Send invite'}</button>
        </>} />
      <ErrorAlert error={invErr} />
      <div className="grid grid-side">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Recent charters</h2></div>
            {m.charters.length === 0 ? <Empty title="No charters yet" /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Charter</th><th>Dates</th><th>Route</th><th>Aircraft</th><th>Status</th></tr></thead>
                <tbody>{m.charters.map(c => (
                  <tr key={c.id}><td className="strong nowrap"><Link to={`/o/charters/${c.id}`}>{c.charter_no}</Link></td><td className="nowrap">{fmtDate(c.starts_on, { year: false })}</td><td className="nowrap">{route(c.legs)}</td><td>{aircraftReg(c)}</td><td><StatusPill status={c.status} /></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>Recent quotes</h2></div>
            {m.quotes.length === 0 ? <Empty title="No quotes yet" /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Quote</th><th>Created</th><th>Route</th><th className="num">Total</th><th>Status</th></tr></thead>
                <tbody>{m.quotes.map(q => (
                  <tr key={q.id}><td className="strong nowrap"><Link to={`/s/requests/${q.request_id}`}>{q.quote_no}</Link></td><td className="nowrap">{fmtDateTime(q.created_at)}</td><td className="nowrap">{route(q.legs)}</td><td className="num">{inr(q.total)}</td><td><StatusPill status={q.status} /></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </div>
        <div className="stack">
          <div className="card card-pad">
            <h3 style={{ marginBottom: 12 }}>Details</h3>
            <dl className="dl">
              <dt>Type</dt><dd style={{ textTransform: 'capitalize' }}>{m.member_type}</dd>
              <dt>Email</dt><dd style={{ wordBreak: 'break-all' }}>{m.email}</dd>
              <dt>Phone</dt><dd>{m.phone}</dd>
              <dt>GSTIN</dt><dd className="mono">{m.gstin || '—'}</dd>
              <dt>Member since</dt><dd>{m.member_since}</dd>
              <dt>Past charters</dt><dd>{m.past_charters}</dd>
            </dl>
            {m.notes && <p className="small" style={{ marginTop: 12 }}>{m.notes}</p>}
          </div>
          <BankTransferPanel memberId={m.id || id} canSimulate={canEdit} />
          <div className="card card-pad">
            <h3 style={{ marginBottom: 12 }}>Portal access</h3>
            {(m.users || []).length === 0 ? <p className="small muted">No login yet. Send an invite to give this member access to the portal.</p> : m.users.map(u => (
              <dl className="dl" key={u.id}>
                <dt>Login</dt><dd style={{ wordBreak: 'break-all' }}>{u.email}</dd>
                <dt>Active</dt><dd>{u.is_active === false ? 'Deactivated' : 'Yes'}</dd>
                <dt>Last login</dt><dd>{u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never (invite pending)'}</dd>
              </dl>
            ))}
          </div>
        </div>
      </div>
      {editing && <MemberForm member={m} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {inviteUrl && <InviteLinkModal url={inviteUrl} email={m.email} onClose={() => setInviteUrl('')} />}
    </>
  );
}

export function InviteLinkModal({ url, email, onClose }) {
  return (
    <Modal title="Invitation sent" onClose={onClose}>
      <p className="small">An email with this link was sent to <strong>{email}</strong>. You can also share it directly — it expires in 72 hours.</p>
      <CopyField value={url} />
      <div className="form-actions"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

function BankTransferPanel({ memberId, canSimulate }) {
  const { data, error, loading } = useFetch(`/api/members/${memberId}/bank-transfer`);
  const [cfg, setCfg] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [ok, setOk] = useState('');
  useEffect(() => { getPaymentsConfig().then(setCfg).catch(() => {}); }, []);
  const va = data?.bank_transfer || data?.virtual_account || data;
  const isMock = cfg?.provider === 'mock';
  return (
    <div className="card card-pad" data-testid="member-bank-transfer">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <h3>Bank transfer account</h3>
        {isMock && <span className="test-badge sm">Test mode</span>}
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <div className="small muted">Loading…</div> : va && !error && (
        <>
          <dl className="dl">
            <dt>Account name</dt><dd>{va.account_name || va.name || '—'}</dd>
            <dt>Account no.</dt><dd className="mono" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{va.account_number}<CopyButton value={va.account_number} what="account number" /></dd>
            <dt>IFSC</dt><dd className="mono" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{va.ifsc}<CopyButton value={va.ifsc} what="IFSC" /></dd>
            {va.bank_name && <><dt>Bank</dt><dd>{va.bank_name}</dd></>}
          </dl>
          <p className="xs muted" style={{ margin: '10px 0 0' }}>Transfers into this account are matched to the member’s oldest open invoice automatically.</p>
        </>
      )}
      <OkAlert>{ok}</OkAlert>
      {isMock && canSimulate && (
        <button className="btn btn-sm btn-gold" style={{ marginTop: 12 }} onClick={() => { setOk(''); setSimulating(true); }} data-testid="simulate-bank-transfer">Simulate bank transfer</button>
      )}
      {simulating && <SimulateTransfer memberId={memberId} onClose={() => setSimulating(false)} onDone={(msg) => { setSimulating(false); setOk(msg); }} />}
    </div>
  );
}

function SimulateTransfer({ memberId, onClose, onDone }) {
  const { data: invoices } = useFetch('/api/invoices');
  const open = (invoices || []).filter(i => i.member_id === memberId && isPayable(i))
    .sort((a, b) => String(a.issued_on).localeCompare(String(b.issued_on)) || String(a.invoice_no).localeCompare(String(b.invoice_no)));
  const oldest = open[0];
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!touched && oldest) setAmount(String(Math.round(invoiceMoney(oldest).balance))); }, [oldest?.id, touched]);

  const submit = async (e) => {
    e.preventDefault();
    const amt = Number(amount);
    if (!amt || amt <= 0) { setError('Enter an amount in rupees.'); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post('/api/payments/mock/bank-transfer', { member_id: memberId, amount: amt });
      const inv = r.data?.invoice;
      onDone(`Simulated transfer of ${inr(amt)} received${inv?.invoice_no ? ` and applied to ${inv.invoice_no}` : ''}${inv?.status ? ` (now ${inv.status.replace(/_/g, ' ')})` : ''}.`);
    } catch (err) { setError(errText(err)); setSaving(false); }
  };

  return (
    <Modal title={<span className="mock-title">Simulate bank transfer <span className="test-badge">Test mode</span></span>} onClose={onClose}>
      <form onSubmit={submit} data-testid="simulate-form">
        <p className="small">Simulates the bank crediting this member’s virtual account (a Razorpay <span className="mono">virtual_account.credited</span> event). The amount is applied to their oldest open invoice.</p>
        {open.length > 0 ? (
          <ul className="el-mini" style={{ margin: '4px 0 14px' }}>
            {open.map(i => (
              <li key={i.id}><span><span className="strong">{i.invoice_no}</span> <span className="muted xs">{i.charter_no}</span></span><span className="actions nowrap"><span>{inr(invoiceMoney(i).balance)}</span><StatusPill status={i.status} /></span></li>
            ))}
          </ul>
        ) : invoices && <div className="alert alert-info">This member has no open invoices — a transfer would be recorded as an over-payment.</div>}
        <div className="field">
          <label htmlFor="sim-amt">Amount (₹)</label>
          <input id="sim-amt" className="input" type="number" min="1" step="1" value={amount} onChange={e => { setTouched(true); setAmount(e.target.value); }} required />
          {amount && Number(amount) > 0 && <span className="hint">{inr(amount)}</span>}
        </div>
        <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" disabled={saving}>{saving ? 'Simulating…' : 'Simulate transfer'}</button>
        </div>
      </form>
    </Modal>
  );
}
