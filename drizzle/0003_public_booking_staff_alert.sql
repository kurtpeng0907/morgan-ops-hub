ALTER TABLE line_staff_alerts
  DROP CONSTRAINT IF EXISTS line_staff_alerts_appointment_id_fkey;

ALTER TABLE line_staff_alerts
  DROP CONSTRAINT IF EXISTS line_staff_alerts_alert_kind_check;

ALTER TABLE line_staff_alerts
  ADD CONSTRAINT line_staff_alerts_alert_kind_check
  CHECK (alert_kind IN ('upcoming', 'public_booking_pending'));

CREATE UNIQUE INDEX line_staff_alerts_public_booking_once
  ON line_staff_alerts (appointment_id, alert_kind)
  WHERE alert_kind = 'public_booking_pending';
