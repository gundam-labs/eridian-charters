import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill } from '../../components/ui';
import { fmtDateTime, fmtDate, route, memberName, aircraftReg, paxCount, humanize } from '../../lib/format';
import { crewName } from '../../lib/normalize';

const COLS = ['accepted', 'confirmed', 'manifest_complete', 'flown', 'closed'];

export default function Charters() {
  const nav = useNavigate();
  const [view, setView] = useState('board');
  const [showCancelled, setShowCancelled] = useState(false);
  const { data, error, loading } = useFetch('/api/charters');
  const list = (data || []).slice().sort((a, b) => String(a.starts_on).localeCompare(String(b.starts_on)));

  return (
    <>
      <PageHead eyebrow="Operations" title="Charters"
        actions={<div className="seg"><button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board</button><button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button></div>} />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No charters yet">Charters are created when a member accepts a quote.</Empty></div>
      ) : view === 'board' ? (
        <>
          <div className="board">
            {COLS.map(s => {
              const items = list.filter(c => c.status === s);
              return (
                <div className="board-col" key={s}>
                  <h3><span>{humanize(s === 'manifest_complete' ? 'manifest complete' : s)}</span><span>{items.length}</span></h3>
                  {items.length === 0 ? <div className="muted xs" style={{ padding: '6px 4px' }}>None</div> : items.map(c => <BoardCard key={c.id} c={c} />)}
                </div>
              );
            })}
          </div>
          <label className="check" style={{ marginTop: 14 }}><input type="checkbox" checked={showCancelled} onChange={e => setShowCancelled(e.target.checked)} /> Show cancelled ({list.filter(c => c.status === 'cancelled').length})</label>
          {showCancelled && <div className="cards" style={{ marginTop: 12 }}>{list.filter(c => c.status === 'cancelled').map(c => <BoardCard key={c.id} c={c} />)}</div>}
        </>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Charter</th><th>Dates</th><th>Route</th><th>Member</th><th>Aircraft</th><th>Captain</th><th className="num">Pax</th><th>Status</th></tr></thead>
            <tbody>
              {list.map(c => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/o/charters/${c.id}`)}>
                  <td className="strong nowrap">{c.charter_no}</td>
                  <td className="nowrap">{fmtDate(c.starts_on, { year: false })}{c.ends_on !== c.starts_on ? ` – ${fmtDate(c.ends_on, { year: false })}` : ''}</td>
                  <td className="nowrap">{route(c.legs)}</td>
                  <td>{memberName(c)}</td>
                  <td className="nowrap">{aircraftReg(c)}</td>
                  <td>{crewName(c, 'captain') || <span className="muted">—</span>}</td>
                  <td className="num">{paxCount(c)}</td>
                  <td><StatusPill status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function BoardCard({ c }) {
  const needsCrew = c.status === 'accepted' && (!crewName(c, 'captain') || !crewName(c, 'first_officer'));
  return (
    <Link to={`/o/charters/${c.id}`} className="board-card">
      <div className="actions" style={{ justifyContent: 'space-between' }}><span className="r">{c.charter_no}</span>{c.status === 'cancelled' && <StatusPill status="cancelled" />}</div>
      <div style={{ marginTop: 4 }}>{route(c.legs)}</div>
      <div className="muted xs" style={{ marginTop: 4 }}>{fmtDateTime(c.legs?.[0]?.depart_at)} · {aircraftReg(c)} · {paxCount(c)} pax</div>
      <div className="muted xs">{memberName(c)}</div>
      {needsCrew && <div className="xs" style={{ color: 'var(--amber-fg)', marginTop: 4, fontWeight: 600 }}>Crew needed</div>}
    </Link>
  );
}
