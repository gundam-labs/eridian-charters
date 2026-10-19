import { Link } from 'react-router-dom';
import { StatusPill } from './ui';
import { fmtDateTime, route, aircraftType, aircraftReg, paxCount } from '../lib/format';
import { crewName } from '../lib/normalize';

export default function TripCard({ charter: c, to, showReg }) {
  const first = c.legs?.[0];
  const cap = crewName(c, 'captain');
  const fo = crewName(c, 'first_officer');
  return (
    <Link to={to} className="trip-card">
      <div className="top">
        <span className="date">{first ? fmtDateTime(first.depart_at) : c.starts_on}</span>
        <StatusPill status={c.status} />
      </div>
      <div className="route">{route(c.legs)}</div>
      <div className="meta">
        <span>{aircraftType(c)}{showReg && aircraftReg(c) ? ` · ${aircraftReg(c)}` : ''}</span>
        <span>{paxCount(c)} pax</span>
        {(cap || fo) && <span>{[cap, fo].filter(Boolean).join(' · ')}</span>}
      </div>
      <div className="ref" style={{ marginTop: 8 }}>{c.charter_no}</div>
    </Link>
  );
}
