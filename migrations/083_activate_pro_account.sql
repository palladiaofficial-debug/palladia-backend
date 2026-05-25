-- 083_activate_pro_account.sql
-- Attiva piano Pro per l'account carpio@mscedilizia.it (owner aziendale)
-- Equivalente a un abbonamento Pro pagato, senza scadenza

UPDATE companies
SET
  subscription_status            = 'active',
  subscription_plan              = 'pro',
  subscription_current_period_end = '2099-12-31 23:59:59+00'
WHERE id IN (
  SELECT cu.company_id
  FROM company_users cu
  JOIN auth.users u ON u.id = cu.user_id
  WHERE u.email = 'carpio@mscedilizia.it'
    AND cu.role  = 'owner'
);
