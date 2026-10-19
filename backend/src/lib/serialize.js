/** Mask an ID number to its last 4 characters: 'XXXX1234'. */
function maskId(idNumber) {
  const s = String(idNumber || '');
  return `XXXX${s.slice(-4)}`;
}

const isMasked = (s) => typeof s === 'string' && /^X{4}/i.test(s);

/** Aircraft fields safe for members/pilots (no rates, no partner). */
function publicAircraft(a) {
  if (!a) return null;
  return { id: a.id, registration: a.registration, type: a.type, seats: a.seats, home_base: a.home_base };
}

module.exports = { maskId, isMasked, publicAircraft };
