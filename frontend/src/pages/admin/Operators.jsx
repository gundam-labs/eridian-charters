import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { PageHead, ErrorAlert, Loading, Empty, Modal, StatusPill } from '../../components/ui';
import { fmtDate, fmtDateTime, istDate } from '../../lib/format';

const FLEET_LABELS = { fixed_wing: 'Fixed wing', rotary_wing: 'Helicopters', mixed: 'Mixed fleet', hot_air_balloon: 'Hot-air balloons' };
const KIND_LABELS = { fixed_wing: 'Fixed wing', rotary_wing: 'Helicopter', hot_air_balloon: 'Balloon' };
const ROLE_LABELS = { passenger: 'Passenger', aerial_work: 'Aerial work', cargo: 'Cargo' };

/** AOP validity: expired, expiring within 6 months, or valid. */
function aopState(date) {
  if (!date) return null;
  const today = istDate();
  const soon = new Date(Date.now() + 182 * 86400000).toISOString().slice(0, 10);
  if (date < today) return { cls: 'pill-red', label: 'AOP expired' };
  if (date <= soon) return { cls: 'pill-amber', label: 'Renewal due' };
  return null;
}

function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export default function Operators() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [fleet, setFleet] = useState('');
  const dq = useDebounced(q.trim());
  const qs = new URLSearchParams(Object.entries({ q: dq, fleet_type: fleet }).filter(([, v]) => v)).toString();
  const { data, error, loading } = useFetch(`/api/operators${qs ? `?${qs}` : ''}`);
  const openId = params.get('op');
  const setOpen = (id) => setParams(p => { const n = new URLSearchParams(p); if (id) n.set('op', id); else n.delete('op'); return n; }, { replace: true });
  const list = useMemo(() => data?.operators || [], [data]);
  const t = data?.totals;

  return (
    <>
      <PageHead eyebrow="Directory" title="Charter operators"
        sub={data?.source
          ? <>Non-scheduled operators (NSOP holders) from the DGCA list as on {fmtDate(data.source.as_of)} · imported {fmtDateTime(data.source.imported_at)}</>
          : 'Non-scheduled operators (NSOP holders) from the DGCA list.'} />
      {t && (
        <div className="stats">
          <div className="stat"><div className="label">Operators</div><div className="value">{t.operators}</div></div>
          <div className="stat"><div className="label">Aircraft</div><div className="value">{t.aircraft}</div></div>
          <div className="stat"><div className="label">Fixed wing</div><div className="value">{t.fixed_wing}</div></div>
          <div className="stat"><div className="label">Helicopters</div><div className="value">{t.rotary_wing}</div></div>
        </div>
      )}
      <div className="filters">
        <input className="input search" type="search" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search name, city, AOP, aircraft model or registration" aria-label="Search operators" />
        <select className="select" value={fleet} onChange={e => setFleet(e.target.value)} aria-label="Fleet type">
          <option value="">All fleets</option>
          {Object.entries(FLEET_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {data && <span className="muted small">{list.length} shown</span>}
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No operators match">Try a different name, city, aircraft model or registration.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Operator</th><th>AOP</th><th>Fleet</th><th>Contact</th></tr></thead>
            <tbody>
              {list.map(o => {
                const st = aopState(o.aop_valid_until);
                return (
                  <tr key={o.id} className="row-link" onClick={() => setOpen(o.id)}>
                    <td style={{ maxWidth: 340 }}>
                      <button className="link-btn strong" onClick={(e) => { e.stopPropagation(); setOpen(o.id); }}>{o.name}</button>
                      <div className="muted xs">{o.address}</div>
                    </td>
                    <td className="nowrap">{o.aop_no}
                      <div className="muted xs">valid to {fmtDate(o.aop_valid_until)}</div>
                      {st && <span className={`pill ${st.cls}`} style={{ marginTop: 4 }}>{st.label}</span>}</td>
                    <td style={{ maxWidth: 300 }}>
                      <span className="strong">{o.aircraft_count}</span> · {FLEET_LABELS[o.fleet_type] || o.fleet_type}
                      {o.max_seats ? <span className="muted"> · up to {o.max_seats} seats</span> : null}
                      <div className="muted xs op-models">{o.models}</div>
                    </td>
                    <td className="xs" style={{ maxWidth: 240 }}>
                      {o.phone && <div>{o.phone}</div>}
                      {(o.emails || []).map(e => <div key={e}><a href={`mailto:${e}`} onClick={ev => ev.stopPropagation()}>{e}</a></div>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {openId && <OperatorModal id={openId} onClose={() => setOpen('')} />}
    </>
  );
}

function OperatorModal({ id, onClose }) {
  const { data: o, error, loading } = useFetch(`/api/operators/${id}`);
  const st = o && aopState(o.aop_valid_until);
  return (
    <Modal title={o?.name || 'Operator'} onClose={onClose} wide>
      <ErrorAlert error={error} />
      {loading && !o ? <Loading /> : o && (
        <>
          <dl className="dl">
            <dt>AOP number</dt><dd>{o.aop_no} · valid to {fmtDate(o.aop_valid_until)}{st && <span className={`pill ${st.cls}`} style={{ marginLeft: 8 }}>{st.label}</span>}</dd>
            <dt>Address</dt><dd>{o.address || '—'}</dd>
            <dt>Phone</dt><dd>{o.phone || '—'}</dd>
            {o.fax && <><dt>Fax</dt><dd>{o.fax}</dd></>}
            <dt>Email</dt><dd>{o.emails?.length ? o.emails.map((e, i) => <span key={e}>{i > 0 && ', '}<a href={`mailto:${e}`}>{e}</a></span>) : '—'}</dd>
            <dt>Fleet</dt><dd>{o.aircraft_count} aircraft · {FLEET_LABELS[o.fleet_type] || o.fleet_type}</dd>
            <dt>Source</dt><dd>DGCA list as on {fmtDate(o.source_as_of)}, entry {o.source_sno}{!o.in_latest_list && <span className="pill pill-amber" style={{ marginLeft: 8 }}>Not in latest list</span>}</dd>
            <dt>On our platform</dt><dd>{o.listers?.length
              ? o.listers.map(l => <div key={l.id}>{l.company || l.name} ({l.email}) <StatusPill status={l.status} /></div>)
              : <span className="muted">Not registered as a lister yet</span>}</dd>
          </dl>
          <h3 style={{ margin: '22px 0 10px', fontSize: '1.05rem' }}>Aircraft</h3>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Registration</th><th>Model</th><th>Type</th><th className="num">Seats</th><th>Use</th></tr></thead>
              <tbody>
                {o.aircraft.map(a => (
                  <tr key={a.registration}>
                    <td className="nowrap strong">{a.registration}</td>
                    <td>{a.model}</td>
                    <td className="nowrap">{KIND_LABELS[a.kind] || a.kind}</td>
                    <td className="num">{a.seats ?? '—'}</td>
                    <td className="nowrap">{ROLE_LABELS[a.role] || a.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
