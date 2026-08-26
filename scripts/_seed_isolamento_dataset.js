#!/usr/bin/env node
'use strict';
/**
 * scripts/_seed_isolamento_dataset.js
 *
 * Seed idempotente per BLOCCO 1 (isolamento multi-tenant, AUDIT.md).
 * Crea/ritrova "TEST-Isolamento-B", una seconda company sintetica indipendente
 * da TEST-AutoExplore (company A), con dati propri in ogni dominio: cantiere,
 * lavoratore, documento, spesa, fattura, cedolino, attestato, mezzo,
 * subappaltatore. Usata da scripts/selftest_cross_tenant_isolation.js.
 *
 * Uso: node scripts/_seed_isolamento_dataset.js
 * Scrive scripts/_isolamento_seed.json con tutti gli ID utili al test.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OUT = path.join(__dirname, '_isolamento_seed.json');

const EMAIL_B = 'isolamento-b@palladia-test.local';

async function ensureUser(email) {
  const { data: list } = await sb.auth.admin.listUsers({ perPage: 1000 });
  let user = list?.users?.find(u => u.email === email);
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({ email, password: 'IsolamentoB!' + Date.now(), email_confirm: true, user_metadata: { full_name: 'Isolamento B Bot' } });
    if (error) throw error;
    user = data.user;
  }
  return user;
}

async function main() {
  console.log('Seed isolamento — company B...\n');

  // 1. Company B
  let { data: companyB } = await sb.from('companies').select('id').eq('name', 'TEST-Isolamento-B').maybeSingle();
  if (!companyB) {
    const { data, error } = await sb.from('companies').insert({
      name: 'TEST-Isolamento-B', vat_number: '09999999999', city: 'Torino', province: 'TO',
      subscription_status: 'active', subscription_plan: 'pro', account_type: 'impresa',
    }).select('id').single();
    if (error) throw error;
    companyB = data;
    console.log('Company B creata:', companyB.id);
  } else {
    console.log('Company B già esistente:', companyB.id);
  }
  const companyId = companyB.id;

  // 2. Utente admin B + membership
  const userB = await ensureUser(EMAIL_B);
  const { data: existingMembership } = await sb.from('company_users').select('id').eq('company_id', companyId).eq('user_id', userB.id).maybeSingle();
  if (!existingMembership) {
    await sb.from('company_users').insert({ company_id: companyId, user_id: userB.id, role: 'admin' });
  }

  // 3. Sito/cantiere
  let { data: site } = await sb.from('sites').select('id').eq('company_id', companyId).limit(1).maybeSingle();
  if (!site) {
    const { data, error } = await sb.from('sites').insert({
      company_id: companyId, name: 'Cantiere Isolamento B', address: 'Via Test B 1', city: 'Torino',
      start_date: '2026-01-01', status: 'attivo',
    }).select('id').single();
    if (error) throw error;
    site = data;
  }

  // 4. Lavoratore
  let { data: worker } = await sb.from('workers').select('id').eq('company_id', companyId).limit(1).maybeSingle();
  if (!worker) {
    const { data, error } = await sb.from('workers').insert({
      company_id: companyId, full_name: 'Lavoratore Isolamento B', fiscal_code: 'ISLB99A01L219X',
      badge_code: 'ISOL-B-' + Date.now(), is_active: true,
    }).select('id').single();
    if (error) throw error;
    worker = data;
  }

  // 5. Spesa
  let { data: expense } = await sb.from('company_expenses').select('id').eq('company_id', companyId).limit(1).maybeSingle();
  if (!expense) {
    const { data, error } = await sb.from('company_expenses').insert({
      company_id: companyId, amount: 500, description: 'Spesa test isolamento B', category: 'materiali',
      payment_method: 'bonifico', supplier: 'Fornitore B', expense_date: '2026-08-01', is_deductible: true, source: 'manual',
    }).select('id').single();
    if (error) console.log('  (expense skip:', error.message, ')');
    else expense = data;
  }

  // 6. Attestato / certificato lavoratore
  let { data: cert } = await sb.from('worker_certificates').select('id').eq('company_id', companyId).limit(1).maybeSingle();
  if (!cert && worker) {
    const { data, error } = await sb.from('worker_certificates').insert({
      worker_id: worker.id, company_id: companyId, issue_date: '2026-01-01', expiry_date: '2027-01-01',
      issuing_body: 'Test Isolamento B',
    }).select('id').single();
    if (error) console.log('  (cert skip:', error.message, ')');
    else cert = data;
  }

  // 7. Mezzo/equipment
  let { data: equipment } = await sb.from('equipment').select('id').eq('company_id', companyId).limit(1).maybeSingle();
  if (!equipment) {
    const { data, error } = await sb.from('equipment').insert({
      company_id: companyId, name: 'Escavatore Isolamento B', type: 'macchina',
    }).select('id').single();
    if (error) console.log('  (equipment skip:', error.message, ')');
    else equipment = data;
  }

  // 8. Subappaltatore
  let { data: subcontractor } = await sb.from('subcontractors').select('id').eq('company_id', companyId).limit(1).maybeSingle();
  if (!subcontractor) {
    const { data, error } = await sb.from('subcontractors').insert({
      company_id: companyId, company_name: 'Subappaltatore B srl', piva: '08888888888',
    }).select('id').single();
    if (error) console.log('  (subcontractor skip:', error.message, ')');
    else subcontractor = data;
  }

  // 9. Documento aziendale
  let { data: doc } = await sb.from('company_documents').select('id').eq('company_id', companyId).limit(1).maybeSingle();
  if (!doc) {
    const { data, error } = await sb.from('company_documents').insert({
      company_id: companyId, name: 'Documento test isolamento B', category: 'altro', file_path: 'test/isolamento-b.pdf',
    }).select('id').single();
    if (error) console.log('  (document skip:', error.message, ')');
    else doc = data;
  }

  // 10. Cedolino
  let { data: payslip } = await sb.from('payslips').select('id').eq('company_id', companyId).limit(1).maybeSingle();
  if (!payslip && worker) {
    const { data, error } = await sb.from('payslips').insert({
      company_id: companyId, worker_id: worker.id, period_year: 2026, period_month: 7,
      filename: 'cedolino-b.pdf', file_path: `payslips/${companyId}/2026/07/test-b.pdf`, file_size: 1000,
    }).select('id').single();
    if (error) console.log('  (payslip skip:', error.message, ')');
    else payslip = data;
  }

  const out = {
    companyId,
    companyName: 'TEST-Isolamento-B',
    userId: userB.id,
    userEmail: EMAIL_B,
    siteId: site?.id || null,
    workerId: worker?.id || null,
    expenseId: expense?.id || null,
    certId: cert?.id || null,
    equipmentId: equipment?.id || null,
    subcontractorId: subcontractor?.id || null,
    documentId: doc?.id || null,
    payslipId: payslip?.id || null,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('\nSeed completato:', JSON.stringify(out, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
