import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { openPdf } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { normCharter, crewName } from '../../lib/normalize';
import { PageHead, ErrorAlert, Loading, StatusPill, OkAlert } from '../../components/ui';
import Timeline from '../../components/Timeline';
import LegsTable from '../../components/LegsTable';
import ManifestEditor from '../../components/ManifestEditor';
import CancelModal from '../../components/CancelModal';
import { fmtDate, inr, aircraftType, route } from '../../lib/format';

export default function TripDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useFetch(`/api/charters/${id}`);
  const c = normCharter(data);
  const [cancelling, setCancelling] = useState(false);
  const [pdfErr, setPdfErr] = useState('');

  if (loading && !c) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  if (!c) return null;

  const canEditManifest = ['accepted', 'confirmed'].includes(c.status);
  const canCancel = ['accepted', 'confirmed', 'manifest_complete'].includes(c.status);
  const crewKnown = !['accepted', 'cancelled'].includes(c.status);
  const inv = c.invoice;

  return (
    <>
      <PageHead
        back={<Link to="/m/trips" className="back">← My trips</Link>}
        eyebrow={c.empty_leg_no || c.empty_leg?.leg_no ? `${c.charter_no} · Empty-leg deal ${c.empty_leg_no || c.empty_leg.leg_no}` : c.charter_no}
        title={route(c.legs)}
        sub={<>{fmtDate(c.starts_on)}{c.ends_on && c.ends_on !== c.starts_on ? ` – ${fmtDate(c.ends_on)}` : ''} · <StatusPill status={c.status} /></>}
        actions={canCancel && <button className="btn btn-danger" onClick={() => setCancelling(true)}>Cancel trip</button>}
      />
      {params.get('booked') && <OkAlert>Your charter is booked. Our operations team will confirm aircraft and crew shortly — please add your passengers below.</OkAlert>}
      <div className="card card-pad"><Timeline charter={c} /></div>

      <div className="grid grid-side" style={{ marginTop: 20 }}>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Flights</h2></div>
            <LegsTable legs={c.legs} />
          </div>
          <ManifestEditor charter={c} canEdit={canEditManifest} canSubmit={canEditManifest} onChanged={reload} />
        </div>
        <div className="stack">
          <div className="card card-pad">
            <h3 style={{ marginBottom: 12 }}>Aircraft &amp; crew</h3>
            <dl className="dl">
              <dt>Aircraft</dt><dd>{aircraftType(c) || '—'}</dd>
              <dt>Passengers</dt><dd>{c.pax}</dd>
              <dt>Captain</dt><dd>{crewKnown ? crewName(c, 'captain') || 'To be assigned' : 'Shared once confirmed'}</dd>
              <dt>First officer</dt><dd>{crewKnown ? crewName(c, 'first_officer') || 'To be assigned' : 'Shared once confirmed'}</dd>
              {crewKnown && crewName(c, 'cabin_crew') && <><dt>Cabin crew</dt><dd>{crewName(c, 'cabin_crew')}</dd></>}
            </dl>
          </div>
          {inv && (
            <div className="card card-pad">
              <h3 style={{ marginBottom: 12 }}>Invoice</h3>
              <dl className="dl">
                <dt>Number</dt><dd>{inv.invoice_no}</dd>
                <dt>Total</dt><dd>{inr(inv.total)}</dd>
                <dt>Due</dt><dd>{fmtDate(inv.due_on)}</dd>
                <dt>Status</dt><dd><StatusPill status={inv.status} /></dd>
              </dl>
              <button className="btn btn-sm" style={{ marginTop: 14 }} onClick={async () => { setPdfErr(''); try { await openPdf(`/api/invoices/${inv.id}/pdf`); } catch (e) { setPdfErr(e.message); } }}>Invoice PDF</button>
              <ErrorAlert error={pdfErr} />
            </div>
          )}
        </div>
      </div>
      {cancelling && (
        <CancelModal path={`/api/charters/${id}/cancel`} title="Cancel trip" confirmLabel="Cancel trip"
          warning="Cancelling releases the aircraft and cancels the invoice. Cancellation terms in your membership agreement apply."
          onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); reload(); }} />
      )}
    </>
  );
}
