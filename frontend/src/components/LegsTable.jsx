import { fmtDateTime, hours } from '../lib/format';

/** Legs table; pass positioning to show positioning legs too. */
export default function LegsTable({ legs = [], positioning = [], showBlock }) {
  const rows = [
    ...(positioning || []).filter(p => p.kind !== 'back' && isBefore(p, legs)).map(l => ({ ...l, _pos: true })),
    ...legs.map((l, i) => ({ ...l, _i: i })),
    ...(positioning || []).filter(p => !(p.kind !== 'back' && isBefore(p, legs))).map(l => ({ ...l, _pos: true })),
  ];
  if (!rows.length) return <p className="muted small">No legs.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th><th>Route</th><th>Departs (IST)</th><th>Arrives (IST)</th>
            <th className="num">Distance</th><th className="num">Flight time</th>
            {showBlock && <><th>Block off</th><th>Block on</th></>}
          </tr>
        </thead>
        <tbody>
          {rows.map((l, k) => (
            <tr key={k} style={l._pos ? { color: 'var(--ink-3)' } : undefined}>
              <td>{l._pos ? <span className="pill pill-grey">Positioning</span> : l._i + 1}</td>
              <td className="strong nowrap">{l.from} → {l.to}</td>
              <td className="nowrap">{fmtDateTime(l.depart_at)}</td>
              <td className="nowrap">{l.arrive_at ? fmtDateTime(l.arrive_at) : '—'}</td>
              <td className="num nowrap">{l.distance_nm != null ? `${Math.round(l.distance_nm)} nm` : '—'}</td>
              <td className="num nowrap">{l.flight_hours != null ? hours(l.flight_hours) : '—'}</td>
              {showBlock && <>
                <td className="nowrap">{l._pos ? '' : fmtDateTime(l.block_off)}</td>
                <td className="nowrap">{l._pos ? '' : fmtDateTime(l.block_on)}</td>
              </>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isBefore(p, legs) {
  if (!legs?.length || !p.depart_at) return false;
  return new Date(p.depart_at) < new Date(legs[0].depart_at);
}
