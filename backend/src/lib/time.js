/**
 * IST (Asia/Kolkata, UTC+05:30, no DST) helpers.
 * Never relies on the server's TZ: calendar dates come from Intl with an
 * explicit timeZone, and ISO strings are built from the fixed +05:30 offset.
 */
const IST_TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60 * 1000;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Parse 'YYYY-MM-DDTHH:mm[:ss]' as IST, or any ISO string with Z/offset. Returns Date or null. */
function parseIST(input) {
  if (input instanceof Date) return isNaN(input) ? null : input;
  if (typeof input !== 'string' || !input.trim()) return null;
  const s = input.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(\.\d+)?)?$/.exec(s);
  let d;
  if (local) d = new Date(`${local[1]}T${local[2]}${local[3] || ':00'}+05:30`);
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) d = new Date(s);
  else return null;
  return isNaN(d) ? null : d;
}

/** IST calendar date 'YYYY-MM-DD' of an instant. */
function istDate(d = new Date()) {
  return dateFmt.format(d instanceof Date ? d : new Date(d));
}

/** ISO 8601 string in IST offset form: 'YYYY-MM-DDTHH:mm:ss+05:30'. */
function toISTISO(d) {
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 19) + '+05:30';
}

/** Human display in IST: '19 Oct 2026, 09:30'. */
function fmtIST(d) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d instanceof Date ? d : new Date(d));
}

function todayIST() { return istDate(new Date()); }

/** Add n days to a 'YYYY-MM-DD' string (pure calendar arithmetic). */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from date a to date b ('YYYY-MM-DD'). */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));
}

module.exports = { IST_TZ, parseIST, istDate, toISTISO, fmtIST, todayIST, addDays, daysBetween, isDateStr };
