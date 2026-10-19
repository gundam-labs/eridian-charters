const TZ = 'Asia/Kolkata';

const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export function inr(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
  return inrFmt.format(Number(v));
}

const dtFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dtYearFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
});
function parts(fmt, d) {
  const o = {};
  fmt.formatToParts(d).forEach(p => { o[p.type] = p.value; });
  return o;
}

/** ISO timestamp → "Tue 4 Nov, 09:30" (IST) */
export function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const p = parts(dtFmt, d);
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

/** ISO timestamp → "09:30" (IST) */
export function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const p = parts(dtFmt, d);
  return `${p.hour}:${p.minute}`;
}

/** 'YYYY-MM-DD' or ISO → "Tue 4 Nov 2026" */
export function fmtDate(v, { year = true } = {}) {
  if (!v) return '—';
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) d = new Date(`${v}T12:00:00+05:30`);
  else d = new Date(v);
  if (isNaN(d)) return String(v);
  const p = parts(dtYearFmt, d);
  return year ? `${p.weekday} ${p.day} ${p.month} ${p.year}` : `${p.weekday} ${p.day} ${p.month}`;
}

/** ISO → 'YYYY-MM-DD' in IST */
export function istDate(v = new Date()) {
  const d = new Date(v);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** ISO → 'YYYY-MM-DDTHH:mm' in IST, for <input type="datetime-local"> */
export function toIstInput(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return '';
  const p = parts(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }), d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** 'YYYY-MM-DDTHH:mm' IST local → full ISO 8601 with +05:30 offset */
export function istInputToIso(v) {
  if (!v) return null;
  return `${v.length === 16 ? v + ':00' : v}+05:30`;
}

/** Add n days to a 'YYYY-MM-DD' string */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function humanize(s) {
  if (!s) return '';
  return String(s).replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

export function hours(v) {
  if (v === null || v === undefined || isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(1)} h`;
}

/** Defensive accessors for joined fields the API may name slightly differently */
export const memberName = (r) =>
  r?.member_name || r?.member?.company || r?.member?.contact_name || r?.company || r?.contact_name || '—';
export const aircraftReg = (r) => r?.registration || r?.aircraft_registration || r?.aircraft?.registration || '';
export const aircraftType = (r) => r?.aircraft_type || r?.aircraft?.type || r?.type || '';
export const paxCount = (r) => r?.passenger_count ?? r?.pax_count ?? r?.passengers?.length ?? r?.pax ?? 0;
export const countOf = (v) => (Array.isArray(v) ? v.length : Number(v || 0));

export function route(legs) {
  if (!Array.isArray(legs) || !legs.length) return '—';
  const codes = [legs[0].from];
  legs.forEach(l => codes.push(l.to));
  return codes.join(' → ');
}
