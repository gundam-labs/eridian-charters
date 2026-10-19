import { useEffect } from 'react';
import { fmtDate, fmtTime, fmtDateTime, istDate } from './format';

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

function side(x, k) {
  // Accepts from_code/from_city/from_name, from_airport_*, or nested {from:{code,city,name}}
  const nested = x[k] && typeof x[k] === 'object' ? x[k] : x[`${k}_airport`] && typeof x[`${k}_airport`] === 'object' ? x[`${k}_airport`] : {};
  return {
    code: x[`${k}_code`] || nested.code || (typeof x[k] === 'string' ? x[k] : ''),
    city: x[`${k}_city`] || x[`${k}_airport_city`] || nested.city || '',
    name: x[`${k}_name`] || x[`${k}_airport_name`] || (typeof x[`${k}_airport`] === 'string' ? x[`${k}_airport`] : '') || nested.name || '',
  };
}

/** Normalise an empty-leg row from the public, member or staff API into one shape. */
export function normLeg(raw) {
  if (!raw) return null;
  const x = raw.empty_leg && !raw.leg_no ? { ...raw.empty_leg, bookings: raw.bookings ?? raw.empty_leg.bookings } : raw;
  const f = side(x, 'from');
  const t = side(x, 'to');
  const price = num(x.price_inr ?? x.price);
  const list = num(x.list_price_inr ?? x.list_price);
  let savings = num(x.savings_pct ?? x.discount_pct);
  if (savings === null && price !== null && list) savings = (1 - price / list) * 100;
  return {
    ...x,
    from_code: f.code, from_city: f.city, from_name: f.name,
    to_code: t.code, to_city: t.city, to_name: t.name,
    aircraft_type: x.aircraft_type || x.aircraft?.type || '',
    registration: x.registration || x.aircraft_registration || x.aircraft?.registration || '',
    seats: num(x.seats ?? x.aircraft?.seats) || 0,
    flight_hours: num(x.flight_hours),
    distance_nm: num(x.distance_nm),
    price_inr: price,
    list_price_inr: list,
    savings_pct: savings === null ? null : Math.round(savings),
    source_charter_no: x.source_charter_no || x.source_charter?.charter_no || '',
    source_charter_id: x.source_charter_id || x.source_charter?.id || null,
    requests_count: num(x.pending_requests_count ?? x.pending_requests ?? x.requests_count) ?? 0,
    bookings_count: num(x.bookings_count) ?? (Array.isArray(x.bookings) ? x.bookings.length : 0),
  };
}

export const legRoute = (l) => `${l.from_code} → ${l.to_code}`;

/** Departure window in IST: { day: 'Thu 5 Nov', range: '07:00 – 10:00', sameDay } */
export function legWindow(l) {
  const a = l.depart_earliest, b = l.depart_latest;
  if (!a) return { day: '—', range: '—', sameDay: true };
  const sameDay = !b || istDate(a) === istDate(b);
  return {
    day: fmtDate(a, { year: false }),
    range: !b ? fmtTime(a) : sameDay ? `${fmtTime(a)} – ${fmtTime(b)}` : `${fmtDateTime(a)} – ${fmtDateTime(b)}`,
    sameDay,
  };
}

export function flightTime(h) {
  if (h === null || h === undefined) return '—';
  const mins = Math.round(Number(h) * 60);
  const hh = Math.floor(mins / 60), mm = mins % 60;
  return hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
}

/** Next n months as [{value:'YYYY-MM', label:'Nov 2026'}] in IST. */
export function monthOptions(n = 6) {
  const [y, m] = istDate().split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 15));
    return {
      value: d.toISOString().slice(0, 7),
      label: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d),
    };
  });
}

/** Normalise an empty-leg booking row (leg summary may be flat or nested). */
export function normBooking(b) {
  if (!b) return null;
  const legRaw = b.empty_leg || b.leg || {
    leg_no: b.leg_no, from_code: b.from_code, to_code: b.to_code, from_city: b.from_city, to_city: b.to_city,
    depart_earliest: b.depart_earliest, depart_latest: b.depart_latest, price_inr: b.price_inr, list_price_inr: b.list_price_inr,
    seats: b.seats, aircraft_type: b.aircraft_type, registration: b.registration, status: b.leg_status,
  };
  return {
    ...b,
    leg: normLeg({ ...legRaw, id: legRaw.id || b.empty_leg_id }),
    customer: b.guest_name || b.member_name || b.member?.contact_name || '—',
    company: b.guest_company || b.member_company || b.member?.company || '',
    email: b.guest_email || b.member_email || b.member?.email || '',
    phone: b.guest_phone || b.member_phone || b.member?.phone || '',
  };
}

export const emptyLegsPath = (role) => (role === 'ops' ? '/o/empty-legs' : '/s/empty-legs');

export function useDocumentTitle(title) {
  useEffect(() => {
    const prev = document.title;
    if (title) document.title = title;
    return () => { document.title = prev; };
  }, [title]);
}
