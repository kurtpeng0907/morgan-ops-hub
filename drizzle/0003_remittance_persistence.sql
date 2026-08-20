ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS remittance_note text NOT NULL DEFAULT '';
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS remittance_account_last5 text NOT NULL DEFAULT '';
