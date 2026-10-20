/**
 * Members' bank-transfer (Smart Collect virtual) accounts: created on first use, one per member, stable afterwards.
 * Creation is serialised per member with a transaction-scoped advisory lock so two concurrent first calls
 * never create two provider accounts.
 */
const { withTransaction } = require('../../db');
const { HttpError } = require('../http');
const { logEvent } = require('../events');
const { provider } = require('./index');

/** → virtual_accounts row for the member (created via the active provider if missing). */
async function getOrCreateVirtualAccount(memberId, actorUserId = null) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('virtual_account:' || $1::text))", [memberId]);
    const member = (await client.query('SELECT id, member_no, contact_name, company FROM members WHERE id = $1', [memberId])).rows[0];
    if (!member) throw new HttpError(404, 'Member not found');
    const prov = provider();
    const existing = (await client.query('SELECT * FROM virtual_accounts WHERE member_id = $1', [memberId])).rows[0];
    if (existing && existing.status === 'active' && existing.provider === prov.name) return existing;

    // Missing, closed, or made by another provider (e.g. mock before live keys): issue a new account.
    const va = await prov.createVirtualAccount({
      name: `Meridian Charters – ${member.member_no} ${member.company || member.contact_name}`.slice(0, 200),
      notes: { member_id: member.id, member_no: member.member_no },
    });
    if (!va?.id || !va.account_number || !va.ifsc) throw new HttpError(502, 'Payment provider error: no bank account returned');
    const row = existing
      ? (await client.query(
        `UPDATE virtual_accounts SET provider = $2, provider_va_id = $3, account_number = $4, ifsc = $5, bank_name = $6, account_name = $7, status = 'active'
          WHERE member_id = $1 RETURNING *`,
        [memberId, prov.name, va.id, va.account_number, va.ifsc, va.bank_name || null, va.name || 'Meridian Charters'])).rows[0]
      : (await client.query(
        `INSERT INTO virtual_accounts (member_id, provider, provider_va_id, account_number, ifsc, bank_name, account_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [memberId, prov.name, va.id, va.account_number, va.ifsc, va.bank_name || null, va.name || 'Meridian Charters'])).rows[0];
    await logEvent({ entity_type: 'member', entity_id: memberId, action: 'virtual_account_created', actor_user_id: actorUserId,
      detail: { provider: prov.name, provider_va_id: va.id, replaced: !!existing } }, client);
    return row;
  });
}

/** Public shape for the member/staff endpoint. */
const bankTransferDetails = (va) => ({ account_name: va.account_name, account_number: va.account_number, ifsc: va.ifsc, bank_name: va.bank_name });

module.exports = { getOrCreateVirtualAccount, bankTransferDetails };
