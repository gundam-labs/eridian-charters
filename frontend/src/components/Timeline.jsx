import { fmtDateTime } from '../lib/format';

const STEPS = [
  { key: 'accepted', label: 'Accepted', at: c => c.created_at },
  { key: 'confirmed', label: 'Confirmed', at: c => c.confirmed_at },
  { key: 'manifest_complete', label: 'Manifest', at: () => null },
  { key: 'flown', label: 'Flown', at: c => c.flown_at },
  { key: 'closed', label: 'Closed', at: c => c.closed_at },
];

export default function Timeline({ charter }) {
  if (charter.status === 'cancelled') {
    return (
      <div className="cancelled-banner">
        <strong>Cancelled</strong>{charter.cancelled_at ? ` · ${fmtDateTime(charter.cancelled_at)}` : ''}
        {charter.cancel_reason && <div style={{ marginTop: 4 }}>Reason: {charter.cancel_reason}</div>}
      </div>
    );
  }
  const idx = STEPS.findIndex(s => s.key === charter.status);
  return (
    <div className="timeline">
      {STEPS.map((s, i) => {
        const cls = i < idx ? 'done' : i === idx ? 'done current' : '';
        const at = i <= idx ? s.at(charter) : null;
        return (
          <div key={s.key} className={`tl-step ${cls}`}>
            <div className="dot">{i < idx || (i === idx && i === STEPS.length - 1) ? '✓' : i + 1}</div>
            {s.label}
            {at && <span className="when">{fmtDateTime(at)}</span>}
          </div>
        );
      })}
    </div>
  );
}
