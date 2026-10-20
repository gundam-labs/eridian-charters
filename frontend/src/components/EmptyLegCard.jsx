import { Link } from 'react-router-dom';
import { inr } from '../lib/format';
import { legWindow, flightTime } from '../lib/emptyLegs';

/** Route block: big codes, city names, flight path between. */
export function RouteLine({ leg, size }) {
  return (
    <div className={`el-route ${size === 'lg' ? 'lg' : ''}`}>
      <div className="el-end">
        <div className="code">{leg.from_code}</div>
        <div className="city">{leg.from_city || leg.from_name}</div>
      </div>
      <div className="el-path" aria-hidden="true">
        <span className="line" /><span className="plane">✈</span><span className="line" />
        {leg.flight_hours != null && <span className="dur">{flightTime(leg.flight_hours)}</span>}
      </div>
      <div className="el-end to">
        <div className="code">{leg.to_code}</div>
        <div className="city">{leg.to_city || leg.to_name}</div>
      </div>
    </div>
  );
}

export function PriceBlock({ leg, align }) {
  return (
    <div className={`el-price ${align === 'left' ? 'left' : ''}`}>
      {leg.list_price_inr != null && leg.list_price_inr > (leg.price_inr || 0) && (
        <div className="was"><s>{inr(leg.list_price_inr)}</s></div>
      )}
      <div className="now">{inr(leg.price_inr)}<span className="gst"> + GST</span></div>
      <div className="per">whole aircraft</div>
    </div>
  );
}

/** Deal card used on the public page and the member page. Pass `to` for a link card or `action` for a button. */
export default function EmptyLegCard({ leg, to, action }) {
  const w = legWindow(leg);
  const body = (
    <>
      <div className="el-card-top">
        <div>
          <div className="el-date">{w.day}</div>
          <div className="el-window">Departs {w.range} <span className="muted">IST</span></div>
        </div>
        {leg.savings_pct > 0 && <span className="el-save">Save {leg.savings_pct}%</span>}
      </div>
      <RouteLine leg={leg} />
      <div className="el-card-foot">
        <div className="el-specs">
          <span className="ac">{leg.aircraft_type || 'Private jet'}</span>
          <span>Up to {leg.seats} seats · <span className="nowrap">{flightTime(leg.flight_hours)}</span></span>
          {leg.marketplace && leg.operated_by && <span className="el-op">Operated by {leg.operated_by}</span>}
        </div>
        <PriceBlock leg={leg} />
      </div>
      {to && <div className="el-cta">View &amp; request <span aria-hidden="true">→</span></div>}
      {action && <div className="el-actions">{action}</div>}
    </>
  );
  return to
    ? <Link to={to} className="el-card" data-testid="el-card">{body}</Link>
    : <div className="el-card" data-testid="el-card">{body}</div>;
}
