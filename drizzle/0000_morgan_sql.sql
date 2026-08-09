CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'therapist')),
  pin_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE therapists (
  therapist_id text PRIMARY KEY REFERENCES users(account_id),
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
  therapist_id text NOT NULL REFERENCES therapists(therapist_id),
  date date NOT NULL,
  shift text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (therapist_id, date)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_key_legacy text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appointments (
  id text PRIMARY KEY,
  date date NOT NULL,
  time time NOT NULL,
  therapist_id text NOT NULL REFERENCES therapists(therapist_id),
  customer_id uuid REFERENCES customers(id),
  customer_key_legacy text NOT NULL DEFAULT '',
  customer_name text NOT NULL DEFAULT '',
  service text NOT NULL DEFAULT '',
  duration integer NOT NULL DEFAULT 60,
  room text NOT NULL DEFAULT 'R',
  price numeric(12,2),
  collected_price numeric(12,2),
  is_completed boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  booking_stage text NOT NULL DEFAULT '',
  remittance_due numeric(12,2),
  remittance_paid boolean NOT NULL DEFAULT false,
  remittance_method text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX appointments_date_time_idx ON appointments(date, time);
CREATE INDEX appointments_therapist_date_idx ON appointments(therapist_id, date);
CREATE INDEX appointments_customer_date_idx ON appointments(customer_id, date DESC);

CREATE TABLE service_records (
  record_id text PRIMARY KEY,
  appointment_id text REFERENCES appointments(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  customer_key_legacy text NOT NULL,
  date date NOT NULL,
  therapist_id text REFERENCES therapists(therapist_id),
  therapist_name text NOT NULL DEFAULT '',
  service text NOT NULL DEFAULT '',
  collected_price numeric(12,2),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  schema_version text NOT NULL DEFAULT 'service-record-v2'
);

CREATE UNIQUE INDEX service_records_appointment_uidx ON service_records(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX service_records_customer_date_idx ON service_records(customer_id, date DESC);
CREATE INDEX service_records_therapist_date_idx ON service_records(therapist_id, date DESC);

CREATE TABLE mutations (
  mutation_id text PRIMARY KEY,
  actor_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'verified', 'failed')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_records (
  key text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  records jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL DEFAULT '',
  mutation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_created_at_idx ON audit_log(created_at DESC);

CREATE TABLE migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_sha256 text NOT NULL,
  source_counts jsonb NOT NULL,
  imported_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'started',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE OR REPLACE FUNCTION morgan_apply_action(
  p_actor_id text,
  p_actor_role text,
  p_mutation_id text,
  p_action text,
  p_data jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
  v_value jsonb;
  v_customer_id uuid;
  v_therapist_id text;
  v_appointment_id text;
  v_record_id text;
BEGIN
  IF p_actor_role <> 'admin' AND p_action NOT IN ('saveSchedule', 'addAppointment', 'saveCustomer', 'saveServiceRecord') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_action = 'saveSchedule' THEN
    v_therapist_id := coalesce(p_data->>'id', '');
    IF p_actor_role <> 'admin' AND v_therapist_id <> p_actor_id THEN RAISE EXCEPTION 'forbidden'; END IF;
    FOR v_key, v_value IN SELECT key, value FROM jsonb_each(coalesce(p_data->'schedule', '{}'::jsonb)) LOOP
      INSERT INTO schedules(therapist_id, date, shift, updated_at)
      VALUES (v_therapist_id, v_key::date, trim(both '"' from v_value::text), now())
      ON CONFLICT (therapist_id, date) DO UPDATE SET shift = EXCLUDED.shift, updated_at = now();
    END LOOP;
    RETURN jsonb_build_object('action', p_action, 'id', v_therapist_id);

  ELSIF p_action = 'addTherapist' THEN
    v_therapist_id := coalesce(p_data->>'id', '');
    INSERT INTO users(account_id, display_name, role, pin_hash, active, updated_at)
    VALUES (v_therapist_id, coalesce(p_data->>'nickname', p_data->>'name', ''), 'therapist', p_data->>'pinHash', true, now())
    ON CONFLICT (account_id) DO UPDATE SET display_name = EXCLUDED.display_name, role = 'therapist',
      pin_hash = EXCLUDED.pin_hash, active = true, updated_at = now();
    INSERT INTO therapists(therapist_id, display_name, active, updated_at)
    VALUES (v_therapist_id, coalesce(p_data->>'nickname', p_data->>'name', ''), true, now())
    ON CONFLICT (therapist_id) DO UPDATE SET display_name = EXCLUDED.display_name, active = true, updated_at = now();
    RETURN jsonb_build_object('action', p_action, 'id', v_therapist_id);

  ELSIF p_action = 'updatePin' THEN
    UPDATE users SET pin_hash = p_data->>'pinHash', updated_at = now() WHERE account_id = p_data->>'id';
    IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found'; END IF;
    RETURN jsonb_build_object('action', p_action, 'id', p_data->>'id');

  ELSIF p_action = 'deleteTherapist' THEN
    v_therapist_id := coalesce(p_data->>'id', '');
    UPDATE users SET active = false, updated_at = now() WHERE account_id = v_therapist_id;
    UPDATE therapists SET active = false, updated_at = now() WHERE therapist_id = v_therapist_id;
    RETURN jsonb_build_object('action', p_action, 'id', v_therapist_id);

  ELSIF p_action = 'saveAdmin' THEN
    INSERT INTO users(account_id, display_name, role, pin_hash, active, updated_at)
    VALUES (p_data->>'id', coalesce(p_data->>'name', ''), 'admin', p_data->>'pinHash', true, now())
    ON CONFLICT (account_id) DO UPDATE SET display_name = EXCLUDED.display_name, role = 'admin',
      pin_hash = EXCLUDED.pin_hash, active = true, updated_at = now();
    RETURN jsonb_build_object('action', p_action, 'id', p_data->>'id');

  ELSIF p_action = 'addAppointment' THEN
    v_appointment_id := coalesce(p_data->>'appId', p_data->>'id', '');
    v_therapist_id := coalesce(p_data->>'therapistId', '');
    IF p_actor_role <> 'admin' AND v_therapist_id <> p_actor_id THEN RAISE EXCEPTION 'forbidden'; END IF;
    v_key := coalesce(p_data->>'phone', '');
    IF v_key <> '' THEN
      INSERT INTO customers(customer_key_legacy, name, updated_at)
      VALUES (v_key, coalesce(p_data->>'customerName', ''), now())
      ON CONFLICT (customer_key_legacy) DO UPDATE SET
        name = CASE WHEN EXCLUDED.name = '' THEN customers.name ELSE EXCLUDED.name END, updated_at = now()
      RETURNING id INTO v_customer_id;
    END IF;
    INSERT INTO appointments(
      id, date, time, therapist_id, customer_id, customer_key_legacy, customer_name, service,
      duration, room, price, collected_price, is_completed, notes, booking_stage,
      remittance_due, remittance_paid, remittance_method, updated_at
    ) VALUES (
      v_appointment_id, (p_data->>'date')::date, (p_data->>'time')::time, v_therapist_id,
      v_customer_id, v_key, coalesce(p_data->>'customerName', ''), coalesce(p_data->>'service', ''),
      coalesce(nullif(p_data->>'duration', '')::integer, 60), coalesce(nullif(p_data->>'room', ''), 'R'),
      nullif(p_data->>'price', '')::numeric, nullif(p_data->>'collectedPrice', '')::numeric,
      coalesce(nullif(p_data->>'isCompleted', '')::boolean, false), coalesce(p_data->>'notes', ''),
      coalesce(p_data->>'bookingStage', ''), nullif(p_data->>'remittanceDue', '')::numeric,
      coalesce(nullif(p_data->>'remittancePaid', '')::boolean, false), coalesce(p_data->>'remittanceMethod', ''), now()
    ) ON CONFLICT (id) DO UPDATE SET
      date = EXCLUDED.date, time = EXCLUDED.time, therapist_id = EXCLUDED.therapist_id,
      customer_id = EXCLUDED.customer_id, customer_key_legacy = EXCLUDED.customer_key_legacy,
      customer_name = EXCLUDED.customer_name, service = EXCLUDED.service, duration = EXCLUDED.duration,
      room = EXCLUDED.room, price = EXCLUDED.price, collected_price = EXCLUDED.collected_price,
      is_completed = EXCLUDED.is_completed, notes = EXCLUDED.notes, booking_stage = EXCLUDED.booking_stage,
      remittance_due = EXCLUDED.remittance_due, remittance_paid = EXCLUDED.remittance_paid,
      remittance_method = EXCLUDED.remittance_method, updated_at = now();
    RETURN jsonb_build_object('action', p_action, 'id', v_appointment_id, 'date', p_data->>'date', 'therapistId', v_therapist_id);

  ELSIF p_action = 'deleteAppointment' THEN
    v_appointment_id := coalesce(p_data->>'appId', p_data->>'id', '');
    IF p_actor_role <> 'admin' AND NOT EXISTS (
      SELECT 1 FROM appointments WHERE id = v_appointment_id AND therapist_id = p_actor_id
    ) THEN RAISE EXCEPTION 'forbidden'; END IF;
    DELETE FROM service_records WHERE appointment_id = v_appointment_id;
    DELETE FROM appointments WHERE id = v_appointment_id;
    RETURN jsonb_build_object('action', p_action, 'id', v_appointment_id);

  ELSIF p_action = 'saveCustomer' THEN
    v_key := coalesce(p_data->>'phone', '');
    IF v_key LIKE 'SYS\_%' ESCAPE '\' THEN
      IF p_actor_role <> 'admin' AND v_key NOT LIKE 'SYS\_APPT\_META\_%' ESCAPE '\'
        AND v_key NOT LIKE 'SYS\_APPROVAL\_%' ESCAPE '\' THEN RAISE EXCEPTION 'forbidden'; END IF;
      INSERT INTO system_records(key, name, notes, records, updated_at)
      VALUES (v_key, coalesce(p_data->>'name', ''), coalesce(p_data->>'notes', ''), coalesce(p_data->'records', '[]'::jsonb), now())
      ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes,
        records = EXCLUDED.records, updated_at = now();
    ELSE
      IF p_actor_role <> 'admin' AND NOT EXISTS (
        SELECT 1 FROM appointments WHERE customer_key_legacy = v_key AND therapist_id = p_actor_id
      ) THEN RAISE EXCEPTION 'forbidden'; END IF;
      INSERT INTO customers(customer_key_legacy, name, notes, updated_at)
      VALUES (v_key, coalesce(p_data->>'name', ''), coalesce(p_data->>'notes', ''), now())
      ON CONFLICT (customer_key_legacy) DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes, updated_at = now();
    END IF;
    RETURN jsonb_build_object('action', p_action, 'id', v_key);

  ELSIF p_action = 'deleteCustomer' THEN
    v_key := coalesce(p_data->>'phone', '');
    IF v_key LIKE 'SYS\_%' ESCAPE '\' THEN DELETE FROM system_records WHERE key = v_key;
    ELSE
      DELETE FROM service_records WHERE customer_key_legacy = v_key;
      UPDATE appointments SET customer_id = NULL WHERE customer_key_legacy = v_key;
      DELETE FROM customers WHERE customer_key_legacy = v_key;
    END IF;
    RETURN jsonb_build_object('action', p_action, 'id', v_key);

  ELSIF p_action = 'saveServiceRecord' THEN
    v_key := coalesce(p_data->>'customer_key_legacy', p_data->>'customerKey', p_data->>'phone', '');
    v_appointment_id := nullif(coalesce(p_data->>'appointment_id', p_data->>'appointmentId', p_data->>'id', ''), '');
    v_record_id := coalesce(p_data->>'record_id', p_data->>'recordId', v_appointment_id, gen_random_uuid()::text);
    v_therapist_id := nullif(coalesce(p_data->>'therapist_id', p_data->>'therapistId', ''), '');
    IF p_actor_role <> 'admin' AND v_therapist_id <> p_actor_id THEN RAISE EXCEPTION 'forbidden'; END IF;
    IF v_appointment_id IS NOT NULL THEN
      SELECT record_id INTO v_record_id FROM service_records WHERE appointment_id = v_appointment_id LIMIT 1;
      IF NOT FOUND THEN v_record_id := coalesce(p_data->>'record_id', p_data->>'recordId', v_appointment_id, gen_random_uuid()::text); END IF;
    END IF;
    INSERT INTO customers(customer_key_legacy, name, updated_at)
    VALUES (v_key, coalesce(p_data->>'customer_name', p_data->>'customerName', ''), now())
    ON CONFLICT (customer_key_legacy) DO UPDATE SET updated_at = now()
    RETURNING id INTO v_customer_id;
    INSERT INTO service_records(
      record_id, appointment_id, customer_id, customer_key_legacy, date, therapist_id,
      therapist_name, service, collected_price, notes, created_at, updated_at, schema_version
    ) VALUES (
      v_record_id, v_appointment_id, v_customer_id, v_key, (p_data->>'date')::date, v_therapist_id,
      coalesce(p_data->>'therapist_name', p_data->>'therapistName', ''), coalesce(p_data->>'service', ''),
      nullif(coalesce(p_data->>'collected_price', p_data->>'collectedPrice', ''), '')::numeric,
      coalesce(p_data->>'notes', ''), coalesce(nullif(p_data->>'created_at', '')::timestamptz, now()), now(), 'service-record-v2'
    ) ON CONFLICT (record_id) DO UPDATE SET
      appointment_id = EXCLUDED.appointment_id, customer_id = EXCLUDED.customer_id,
      customer_key_legacy = EXCLUDED.customer_key_legacy, date = EXCLUDED.date,
      therapist_id = EXCLUDED.therapist_id, therapist_name = EXCLUDED.therapist_name,
      service = EXCLUDED.service, collected_price = EXCLUDED.collected_price,
      notes = EXCLUDED.notes, updated_at = now(), schema_version = 'service-record-v2';
    RETURN jsonb_build_object('action', p_action, 'id', v_record_id, 'appointmentId', v_appointment_id);

  ELSIF p_action = 'repairTherapists' THEN
    RETURN jsonb_build_object('action', p_action, 'id', 'noop');
  ELSE
    RAISE EXCEPTION 'unsupported_action:%', p_action;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION apply_morgan_mutation(
  p_mutation_id text,
  p_actor_id text,
  p_actor_role text,
  p_action text,
  p_data jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing jsonb;
  v_changed jsonb := '[]'::jsonb;
  v_item jsonb;
  v_result jsonb;
BEGIN
  IF p_mutation_id IS NULL OR length(trim(p_mutation_id)) < 6 THEN RAISE EXCEPTION 'invalid_mutation_id'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_mutation_id, 0));

  SELECT result INTO v_existing FROM mutations WHERE mutation_id = p_mutation_id AND status = 'verified';
  IF FOUND THEN RETURN v_existing; END IF;

  INSERT INTO mutations(mutation_id, actor_id, status, result)
  VALUES (p_mutation_id, p_actor_id, 'pending', '{}'::jsonb)
  ON CONFLICT (mutation_id) DO UPDATE SET updated_at = now();

  IF p_action = 'batch' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_data->'actions', '[]'::jsonb)) LOOP
      v_changed := v_changed || jsonb_build_array(morgan_apply_action(
        p_actor_id, p_actor_role, p_mutation_id, v_item->>'action', coalesce(v_item->'data', '{}'::jsonb)
      ));
    END LOOP;
  ELSE
    v_changed := jsonb_build_array(morgan_apply_action(p_actor_id, p_actor_role, p_mutation_id, p_action, coalesce(p_data, '{}'::jsonb)));
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'verified', true,
    'mutationId', p_mutation_id,
    'changedEntities', v_changed,
    'version', extract(epoch from clock_timestamp())::bigint::text
  );
  UPDATE mutations SET status = 'verified', result = v_result, updated_at = now() WHERE mutation_id = p_mutation_id;
  INSERT INTO audit_log(actor_id, action, entity_type, entity_id, mutation_id, metadata)
  VALUES (p_actor_id, p_action, 'mutation', p_mutation_id, p_mutation_id, jsonb_build_object('changedCount', jsonb_array_length(v_changed)));
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION morgan_apply_action(text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_morgan_mutation(text, text, text, text, jsonb) FROM PUBLIC;
