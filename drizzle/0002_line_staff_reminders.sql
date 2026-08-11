CREATE TABLE line_staff_recipients (
  recipient_key text PRIMARY KEY CHECK (recipient_key = 'staff-group'),
  recipient_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE line_staff_alerts (
  appointment_id text NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  alert_kind text NOT NULL CHECK (alert_kind = 'upcoming'),
  scheduled_at timestamptz NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (appointment_id, alert_kind, scheduled_at)
);
