-- Morgan LINE member identity is intentionally isolated from existing customer
-- contact keys.  Historic records are linked only by an authenticated admin.
CREATE TABLE IF NOT EXISTS customer_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id text NOT NULL UNIQUE,
  line_display_name text NOT NULL DEFAULT '',
  picture_url text NOT NULL DEFAULT '',
  contact_name text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_legacy_links (
  member_id uuid NOT NULL REFERENCES customer_members(id),
  customer_key_legacy text NOT NULL REFERENCES customers(customer_key_legacy),
  linked_by text NOT NULL DEFAULT '',
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, customer_key_legacy),
  UNIQUE (customer_key_legacy)
);
CREATE INDEX IF NOT EXISTS member_legacy_links_member_idx ON member_legacy_links(member_id);

CREATE TABLE IF NOT EXISTS line_customer_alerts (
  id bigserial PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES customer_members(id),
  booking_id text NOT NULL,
  alert_kind text NOT NULL CHECK (alert_kind IN ('booking_confirmed', 'booking_cancelled')),
  sent_at timestamptz,
  failed_at timestamptz,
  error_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, booking_id, alert_kind)
);
