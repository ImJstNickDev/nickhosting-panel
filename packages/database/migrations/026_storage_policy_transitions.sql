-- Storage budgets have independent lifetimes from temporary CPU/RAM overrides.
CREATE TABLE storage_user_budgets (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE RESTRICT,
  storage_mib bigint NOT NULL CHECK (storage_mib > 0 AND storage_mib <= 1073741824),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE storage_policy_transitions (
  id uuid PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('draft','applying','blocked','completed','superseded')),
  policy text NOT NULL CHECK (policy IN ('GLOBAL_POOL','PER_USER_BUDGET')),
  previous_policy text NOT NULL CHECK (previous_policy IN ('GLOBAL_POOL','PER_USER_BUDGET')),
  default_user_storage_mib integer NOT NULL CHECK (default_user_storage_mib BETWEEN 1 AND 1073741824),
  plan jsonb NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX storage_policy_one_active ON storage_policy_transitions ((true))
  WHERE status IN ('draft','applying','blocked');
