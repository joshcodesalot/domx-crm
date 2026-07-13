-- Migrate legacy admin role to owner
UPDATE users SET role = 'owner' WHERE role = 'admin';

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  rank INT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  "roleId" UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  "permissionId" UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY ("roleId", "permissionId")
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions ("roleId");
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission ON role_permissions ("permissionId");

-- Constrain users.role to valid role slugs
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'manager', 'team_leader', 'chatter'));
