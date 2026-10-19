import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal, StatusPill } from '../../components/ui';
import { istDate, addDays, fmtDate, humanize } from '../../lib/format';

export default function FleetCalendar() {
  const today = istDate();
  const [range, setRange] = useState(14);
  const [start, setStart] = useState(today);
  const end = addDays(start, range - 1);
  const { data, error, loading } = useFetch(`/api/aircraft/availability?from=${start}&to=${end}`);
  const [cell, setCell] = useState(null);
  const days = data?.days || [];
  const fleet = data?.aircraft || [];

  // utilisation in this window
  const totals = { free: 0, charter: 0, maintenance: 0, inactive: 0 };
  fleet.forEach(a => (a.cells || []).forEach(c => { totals[c.state] = (totals[c.state] || 0) + 1; }));

  return (
    <>
      <PageHead eyebrow="Operations" title="Fleet calendar"
        sub={`${fmtDate(start, { year: false })} – ${fmtDate(end)} · ${fleet.length} aircraft`}
        actions={<>
          <button className="btn btn-sm" onClick={() => setStart(addDays(start, -range))}>← Prev</button>
          <button className="btn btn-sm" onClick={() => setStart(today)} disabled={start === today}>Today</button>
          <button className="btn btn-sm" onClick={() => setStart(addDays(start, range))}>Next →</button>
          <div className="seg">
            <button className={range === 14 ? 'on' : ''} onClick={() => setRange(14)}>14 days</button>
            <button className={range === 30 ? 'on' : ''} onClick={() => setRange(30)}>30 days</button>
          </div>
        </>} />

      <div className="actions" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="legend">
          <span><i style={{ background: 'var(--cal-free)' }} />Free ({totals.free})</span>
          <span><i style={{ background: 'var(--cal-charter)' }} />Charter ({totals.charter})</span>
          <span><i style={{ background: 'var(--cal-maint)' }} />Maintenance ({totals.maintenance})</span>
          <span><i style={{ background: 'repeating-linear-gradient(45deg, var(--cal-inactive), var(--cal-inactive) 3px, #c9cbd0 3px, #c9cbd0 6px)' }} />Inactive ({totals.inactive})</span>
        </div>
        <span className="muted xs">Aircraft-days · click a block for details</span>
      </div>

      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : fleet.length === 0 ? (
        <div className="card"><Empty title="No aircraft">Add aircraft to see the fleet calendar.</Empty></div>
      ) : (
        <div className="cal-wrap" style={loading ? { opacity: 0.6 } : undefined}>
          <table className="cal">
            <thead>
              <tr>
                <th className="ac-cell">Aircraft</th>
                {days.map(d => {
                  const dt = new Date(`${d}T12:00:00+05:30`);
                  const dow = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(dt);
                  const wk = ['Sat', 'Sun'].includes(dow);
                  return (
                    <th key={d} className={`${wk ? 'weekend' : ''} ${d === today ? 'today' : ''}`}>
                      <span className="dow">{dow.slice(0, 2)}</span>{Number(d.slice(8))}
                      {(d.slice(8) === '01' || d === days[0]) && <span className="dow">{new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(dt)}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {fleet.map(a => {
                const byDate = Object.fromEntries((a.cells || []).map(c => [c.date, c]));
                return (
                  <tr key={a.id} data-reg={a.registration}>
                    <td className="ac-cell">
                      <div className="reg">{a.registration}</div>
                      <div className="t">{shortType(a.type)} · {a.seats}s · {a.home_base}</div>
                    </td>
                    {days.map((d, i) => {
                      const c = byDate[d] || { date: d, state: 'free' };
                      const prev = byDate[days[i - 1]];
                      const startsBlock = c.state !== 'free' && (!prev || prev.ref !== c.ref || prev.state !== c.state);
                      return (
                        <td key={d} data-date={d} className={`day ${c.state} ${d === today ? 'today' : ''}`}>
                          <button type="button" title={`${a.registration} · ${fmtDate(d, { year: false })} · ${humanize(c.state)}${c.label ? ` · ${c.label}` : ''}`}
                            onClick={() => c.state !== 'inactive' && setCell({ aircraft: a, cell: c })}
                            disabled={c.state === 'inactive'}>
                            {startsBlock && c.state !== 'inactive' ? <span style={{ padding: '0 3px', whiteSpace: 'nowrap' }}>{c.state === 'maintenance' ? 'MX' : String(c.label || '').split(' · ')[0].replace(/^CH-\d{4}-/, '#')}</span> : null}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cell && <CellModal {...cell} onClose={() => setCell(null)} />}
    </>
  );
}

function shortType(t = '') {
  return t.replace('Bombardier ', '').replace('Embraer ', '').replace('Gulfstream ', '');
}

function CellModal({ aircraft, cell, onClose }) {
  return (
    <Modal title={`${aircraft.registration} · ${fmtDate(cell.date)}`} onClose={onClose}>
      <dl className="dl">
        <dt>Aircraft</dt><dd>{aircraft.type} · {aircraft.seats} seats · base {aircraft.home_base}</dd>
        <dt>State</dt><dd><StatusPill status={cell.state} /></dd>
        {cell.label && <><dt>Detail</dt><dd>{cell.label}</dd></>}
      </dl>
      <div className="form-actions">
        {cell.state === 'charter' && cell.ref && <CharterLink refId={cell.ref} />}
        {cell.state === 'maintenance' && <Link className="btn" to="/o/maintenance">Maintenance blocks</Link>}
        {cell.state === 'free' && <Link className="btn" to={`/o/maintenance?aircraft_id=${aircraft.id}&date=${cell.date}`}>Block for maintenance</Link>}
        <button className="btn btn-primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

// `ref` may be a charter id (UUID) or a charter number; resolve numbers via the charters list.
function CharterLink({ refId }) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(refId));
  const { data } = useFetch(isUuid ? null : '/api/charters');
  const id = isUuid ? refId : (data || []).find(c => c.charter_no === refId)?.id;
  if (!id) return null;
  return <Link className="btn btn-gold" to={`/o/charters/${id}`}>Open charter</Link>;
}
