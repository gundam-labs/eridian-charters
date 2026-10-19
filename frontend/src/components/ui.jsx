import { useState, useEffect } from 'react';
import { humanize } from '../lib/format';

const STATUS_COLOURS = {
  // quote requests
  open: 'blue', quoted: 'violet', closed: 'grey',
  // quotes
  draft: 'grey', sent: 'blue', accepted: 'green', declined: 'red', expired: 'amber', withdrawn: 'grey',
  // charters
  confirmed: 'teal', manifest_complete: 'violet', flown: 'navy', cancelled: 'red',
  // invoices
  unpaid: 'amber', paid: 'green',
  // members/users
  active: 'green', inactive: 'grey', invited: 'amber', none: 'grey',
  // calendar
  free: 'green', charter: 'navy', maintenance: 'amber',
  // email
  logged: 'grey', failed: 'red',
};

export function StatusPill({ status, label }) {
  if (!status) return null;
  const c = STATUS_COLOURS[status] || 'grey';
  return <span className={`pill pill-${c}`}>{label || humanize(status)}</span>;
}

export function TierPill({ tier }) {
  if (!tier) return null;
  return <span className={`pill tier-${tier}`}>{tier}</span>;
}

export function RolePill({ role }) {
  const c = { admin: 'navy', sales: 'blue', ops: 'teal', pilot: 'violet', member: 'gold' }[role] || 'grey';
  return <span className={`pill pill-${c}`}>{role}</span>;
}

export function Empty({ title = 'Nothing here yet', children, action }) {
  return (
    <div className="empty">
      <div className="empty-mark">✦</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="loading"><span className="spinner" />{label}</div>;
}

export function ErrorAlert({ error }) {
  if (!error) return null;
  return <div className="alert alert-error" role="alert">{error}</div>;
}

export function OkAlert({ children }) {
  if (!children) return null;
  return <div className="alert alert-ok">{children}</div>;
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function CopyField({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); }
    catch {
      const t = document.createElement('textarea'); t.value = value; document.body.appendChild(t); t.select();
      document.execCommand('copy'); t.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="copy-row">
      <input className="input" readOnly value={value} onFocus={e => e.target.select()} />
      <button type="button" className="btn btn-gold" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
    </div>
  );
}

export function PageHead({ eyebrow, title, sub, back, actions }) {
  return (
    <div className="page-head">
      <div>
        {back}
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Toast({ message, onDone }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => onDone?.(), 2600);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return <div className="toast">{message}</div>;
}
