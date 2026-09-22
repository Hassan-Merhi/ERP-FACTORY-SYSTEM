CREATE TABLE IF NOT EXISTS factory_container_ais_position_history (
  id serial PRIMARY KEY,
  company_id integer NOT NULL,
  container_id integer NOT NULL REFERENCES factory_containers(id) ON DELETE CASCADE,
  mmsi varchar(16) NOT NULL,
  vessel_name varchar(255),
  latitude decimal(10,7) NOT NULL,
  longitude decimal(11,7) NOT NULL,
  speed_knots decimal(8,3),
  course decimal(8,3),
  heading integer,
  navigation_status varchar(100),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT factory_container_ais_history_latitude_check CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT factory_container_ais_history_longitude_check CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS factory_container_ais_history_container_observed_idx
  ON factory_container_ais_position_history (container_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS factory_container_ais_history_mmsi_observed_idx
  ON factory_container_ais_position_history (mmsi, observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS factory_container_ais_history_sample_unique
  ON factory_container_ais_position_history (container_id, mmsi, observed_at);
