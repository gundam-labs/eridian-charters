import { useState, Fragment } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { normCharter, crewName } from '../../lib/normalize';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, OkAlert } from '../../components/ui';
import FlightLogForm from '../../components/FlightLogForm';
import { charterPaymentStatus } from '../../lib/payments';
import { fmtDateTime, fmtTime, hours, route, aircraftReg, aircraftType, paxCount } from '../../lib/format';

export default function FlightDetail() {
  const { id } = useParams();
  const { data, error, loading, reload } = useFetch(`/api/charters/${id}`);
  const c = normCharter(data);
  const [ok, setOk] = useState('');

  if (loading && !c) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  if (!c) return null;

  const payStatus = charterPaymentStatus(c);
  const awaitingPayment = !!payStatus && payStatus !== 'paid';
  const crew = [['Captain', crewName(c, 'captain')], ['First officer', crewName(c, 'first_officer')], ['Cabin', crewName(c, 'cabin_crew')]].filter(([, n]) => n);

  return (
    <>
      <PageHead back={<Link to="/p" className="back">← My flights</Link>} eyebrow={c.charter_no} title={route(c.legs)}
        sub={<>{aircraftReg(c)} · {aircraftType(c)} · {paxCount(c)} pax · <StatusPill status={c.status} />{payStatus && <span className="pay-badge"><StatusPill status={payStatus} label={payStatus === 'paid' ? 'Paid' : 'Awaiting payment'} /></span>}</>} />
      <OkAlert>{ok}</OkAlert>

      <div className="stack">
        <div className="card card-pad">
          <h3 style={{ marginBottom: 12 }}>Legs</h3>
          {(c.legs || []).map((l, i) => (
            <div className="pilot-leg" key={i}>
              <div className="hdr"><span className="rt">{l.from} → {l.to}</span><span className="muted xs">Leg {i + 1}</span></div>
              <div className="small">
                <div>Dep {fmtDateTime(l.depart_at)} · Arr {fmtTime(l.arrive_at)}</div>
                <div className="muted">{l.distance_nm != null ? `${Math.round(l.distance_nm)} nm · ` : ''}{hours(l.flight_hours)}</div>
                {l.block_off && <div style={{ marginTop: 4 }}>Block {fmtTime(l.block_off)} – {fmtTime(l.block_on)}</div>}
              </div>
            </div>
          ))}
        </div>

        {crew.length > 0 && (
          <div className="card card-pad">
            <h3 style={{ marginBottom: 12 }}>Crew</h3>
            <dl className="dl">{crew.map(([r, n]) => <Fragment key={r}><dt>{r}</dt><dd>{n}</dd></Fragment>)}</dl>
          </div>
        )}

        <div className="card">
          <div className="card-head"><h3>Passengers</h3><span className="muted xs">{c.passengers.length}</span></div>
          {c.passengers.length === 0 ? <Empty title="Manifest pending">The passenger list hasn’t been submitted yet.</Empty> : (
            <div className="card-body">
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {c.passengers.map((p, i) => <li key={p.id || i} style={{ padding: '4px 0' }}>{p.full_name}{p.nationality && p.nationality !== 'Indian' ? <span className="muted small"> · {p.nationality}</span> : null}</li>)}
              </ol>
            </div>
          )}
        </div>

        {c.status === 'manifest_complete' ? (
          <div className="card card-pad">
            <h3 style={{ marginBottom: 4 }}>Flight log</h3>
            <p className="muted small">Enter block off and block on for each leg (IST).</p>
            <FlightLogForm charter={c} compact awaitingPayment={awaitingPayment} onDone={() => { setOk('Flight log submitted. Thank you, Captain.'); reload(); }} />
          </div>
        ) : ['accepted', 'confirmed'].includes(c.status) ? (
          <div className="alert alert-info">The flight log opens once the passenger manifest is complete.</div>
        ) : c.defects ? (
          <div className="alert alert-warn"><strong>Defects logged:</strong> {c.defects}</div>
        ) : null}
      </div>
    </>
  );
}
