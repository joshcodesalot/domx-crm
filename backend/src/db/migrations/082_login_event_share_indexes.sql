-- Lookups for accounts that share a device id or an IP.

CREATE INDEX IF NOT EXISTS login_events_device_id_idx
  ON login_events ("deviceId")
  WHERE COALESCE("deviceId", '') <> '';

CREATE INDEX IF NOT EXISTS login_events_ip_address_idx
  ON login_events ("ipAddress")
  WHERE COALESCE("ipAddress", '') <> '';
