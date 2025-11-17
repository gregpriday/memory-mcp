# Database Migrations Guide

This guide covers setting up PostgreSQL with pgvector extension and running migrations for the Memory MCP server.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installing PostgreSQL and pgvector](#installing-postgresql-and-pgvector)
  - [macOS](#macos)
  - [Linux](#linux)
  - [Windows](#windows)
- [Database Configuration](#database-configuration)
- [Running Migrations](#running-migrations)
- [Schema Verification](#schema-verification)
- [Rollback Procedures](#rollback-procedures)
- [Seed Data (Optional)](#seed-data-optional)
- [Cloud-Hosted PostgreSQL](#cloud-hosted-postgresql)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before running migrations, ensure you have:

- **PostgreSQL ≥ 15** installed and running
- **pgvector extension** available
- **psql** command-line client in your PATH
- **Repository cloned** to your local machine
- **Database credentials** ready

## Installing PostgreSQL and pgvector

### macOS

**Option 1: Homebrew (Recommended)**

```bash
# Install PostgreSQL
brew install postgresql@15

# Add PostgreSQL to PATH (for keg-only formula)
echo 'export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# Start PostgreSQL service
brew services start postgresql@15

# Install pgvector
brew install pgvector

# Verify PostgreSQL is running
psql postgres -c "SELECT version();"
```

**Option 2: Postgres.app**

1. Download from [https://postgresapp.com/](https://postgresapp.com/)
2. Install and launch Postgres.app
3. Add psql to PATH: `sudo mkdir -p /etc/paths.d && echo /Applications/Postgres.app/Contents/Versions/latest/bin | sudo tee /etc/paths.d/postgresapp`
4. pgvector is bundled with Postgres.app - enable it via `CREATE EXTENSION vector;`

**Note**: pgvector comes pre-installed with Postgres.app. If you need to build a custom version, use: `env PG_CONFIG=/Applications/Postgres.app/Contents/Versions/latest/bin/pg_config make && make install`

### Linux

**Debian/Ubuntu:**

```bash
# Add PostgreSQL PGDG repository (required for PostgreSQL 15+ on older Ubuntu releases)
sudo install -d /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg
echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt/ $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list

# Install PostgreSQL and pgvector
sudo apt update
sudo apt install -y postgresql-15 postgresql-client-15 postgresql-15-pgvector postgresql-server-dev-15 build-essential git

# Start and enable PostgreSQL service
sudo systemctl enable --now postgresql

# Verify installation
sudo -u postgres psql -c "SELECT version();"
```

**Note**: The `postgresql-15-pgvector` package provides pgvector directly. If you need a newer version, you can build from source:

```bash
cd /tmp
git clone --branch v0.5.1 https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install
```

**Fedora/CentOS/RHEL:**

```bash
# Add PostgreSQL PGDG repository
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm

# Disable default PostgreSQL module
sudo dnf -qy module disable postgresql

# Install PostgreSQL and dependencies
sudo dnf install -y postgresql15-server postgresql15-contrib postgresql15-pgvector postgresql15-devel gcc make git

# Initialize and start PostgreSQL 15
sudo /usr/pgsql-15/bin/postgresql-15-setup initdb
sudo systemctl enable --now postgresql-15

# Verify installation
sudo -u postgres psql -c "SELECT version();"
```

**Note**: The `postgresql15-pgvector` package provides pgvector directly. If you need a custom build, you can compile from source after installing the dependencies above.

### Windows

**Option 1: EnterpriseDB Installer (Recommended)**

1. Download PostgreSQL installer from [https://www.enterprisedb.com/downloads/postgres-postgresql-downloads](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads)
2. Run installer and follow the wizard (note the password you set)
3. Add PostgreSQL bin directory to PATH:
   ```powershell
   # In PowerShell (as Administrator)
   $env:Path += ";C:\Program Files\PostgreSQL\15\bin"
   [Environment]::SetEnvironmentVariable("Path", $env:Path, [EnvironmentVariableTarget]::Machine)
   ```

**Installing pgvector on Windows:**

**Option A - Stack Builder (Recommended)**

Use the Stack Builder tool that comes with EnterpriseDB PostgreSQL to install pgvector if available in the extensions catalog.

**Option B - Build from source (requires Visual Studio with C++ tools)**

```powershell
# Open "x64 Native Tools Command Prompt for VS" (from Start Menu)

# Clone pgvector repository
git clone --branch v0.5.1 https://github.com/pgvector/pgvector.git
cd pgvector

# Set PostgreSQL root directory
$env:PGROOT = "C:\Program Files\PostgreSQL\15"

# Build and install
nmake /F Makefile.win
nmake /F Makefile.win install
```

This installs `vector.dll` and control files into your PostgreSQL installation.

**Note**: For Windows users, using a cloud-hosted PostgreSQL service (see [Cloud-Hosted PostgreSQL](#cloud-hosted-postgresql)) is often simpler than local installation.

## Database Configuration

### 1. Create Database and User

```bash
# Switch to postgres user (Linux) or use psql directly (macOS/Windows)
sudo -u postgres psql  # Linux
# or
psql postgres  # macOS/Windows

# Create database
CREATE DATABASE memory_default;

# Create user (optional - use existing user if preferred)
CREATE USER memory_user WITH PASSWORD 'secure_password';

# Grant privileges
GRANT ALL PRIVILEGES ON DATABASE memory_default TO memory_user;

# Exit psql
\q
```

### 2. Enable pgvector Extension

```bash
# Connect to your database
psql postgresql://postgres:postgres@localhost:5432/memory_default

# Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

# Verify installation
SELECT installed_version FROM pg_available_extensions WHERE name='vector';

# Exit psql
\q
```

You should see the pgvector version (e.g., `0.5.1`).

### 3. Configure Database Connection

The Memory MCP server uses `config/projects.json` to map project IDs to database URLs.

**Edit `config/projects.json`:**

```json
{
  "local": {
    "databaseUrl": "postgresql://username:password@localhost:5432/memory_default"
  }
}
```

Replace `username`, `password`, and database name with your actual credentials.

**Set environment variables in `.env`:**

```bash
# Copy example config
cp .env.example .env

# Edit .env to match your setup
MEMORY_BACKEND=postgres
MEMORY_POSTGRES_PROJECT_REGISTRY=./config/projects.json
MEMORY_ACTIVE_PROJECT=local
OPENAI_API_KEY=your_openai_api_key_here
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

**Alternative: Use DATABASE_URL directly**

For quick testing, you can also use the `DATABASE_URL` environment variable:

```bash
export DATABASE_URL="postgresql://username:password@localhost:5432/memory_default"
```

## Running Migrations

Migrations are plain SQL files executed via `psql`. The current migration structure:

```
migrations/
├── 20250117000001_init_postgres_schema.sql   # Initial schema
└── seeds/
    └── 01_test_data.sql                     # Optional test data
```

### Execute Initial Migration

**Using DATABASE_URL environment variable:**

```bash
# Set DATABASE_URL
export DATABASE_URL="postgresql://username:password@localhost:5432/memory_default"

# Run the migration
psql "$DATABASE_URL" -f migrations/20250117000001_init_postgres_schema.sql
```

**Using direct connection string:**

```bash
psql "postgresql://username:password@localhost:5432/memory_default" \
  -f migrations/20250117000001_init_postgres_schema.sql
```

**Windows (PowerShell):**

```powershell
# Set DATABASE_URL
$env:DATABASE_URL = "postgresql://username:password@localhost:5432/memory_default"

# Run the migration (note: --dbname flag prevents PowerShell parsing issues)
psql --dbname "$env:DATABASE_URL" -f migrations/20250117000001_init_postgres_schema.sql
```

### Run All Migrations (Future-proof)

As more migration files are added, you can run them all sequentially:

**Unix/macOS/Linux:**

```bash
# Run all migrations in order
for migration in migrations/*.sql; do
  echo "Running $migration..."
  psql "$DATABASE_URL" -f "$migration" -v ON_ERROR_STOP=1
  if [ $? -ne 0 ]; then
    echo "Migration failed: $migration"
    exit 1
  fi
done
```

**Windows (PowerShell):**

```powershell
# Run all migrations in order
Get-ChildItem migrations\*.sql | Sort-Object Name | ForEach-Object {
  Write-Host "Running $($_.Name)..."
  psql --dbname "$env:DATABASE_URL" -f $_.FullName -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Migration failed: $($_.Name)"
    exit 1
  }
}
```

### Migration Output

Successful migration output will show:

```
CREATE EXTENSION
CREATE EXTENSION
CREATE TABLE
CREATE INDEX
CREATE INDEX
...
INSERT 0 1
```

## Schema Verification

After running migrations, verify the schema was created correctly:

### 1. List All Tables

```bash
psql "$DATABASE_URL" -c "\dt"
```

Expected output:

```
                   List of relations
 Schema |         Name         | Type  |  Owner
--------+----------------------+-------+----------
 public | memories             | table | postgres
 public | memory_indexes       | table | postgres
 public | memory_relationships | table | postgres
 public | memory_usage_log     | table | postgres
```

### 2. Verify pgvector Extension

```bash
psql "$DATABASE_URL" -c "SELECT installed_version FROM pg_available_extensions WHERE name='vector';"
```

Expected output (version may vary by installation method):

```
 installed_version
-------------------
 0.5.1
 (or 0.7.x, depending on your package manager)
```

### 3. Check Table Structure

```bash
# Describe memories table
psql "$DATABASE_URL" -c "\d memories"

# Verify vector column type
psql "$DATABASE_URL" -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='memories' AND column_name='embedding';"
```

Expected output should show `embedding` column with type `USER-DEFINED` (vector type).

### 4. Verify Indexes

```bash
psql "$DATABASE_URL" -c "\di"
```

Should list multiple indexes including `idx_memories_embedding_ivfflat` for vector search.

### 5. Run a Test Query

```bash
# Check if default index was created
psql "$DATABASE_URL" -c "SELECT project, name, description FROM memory_indexes;"
```

Expected output:

```
 project |  name  |              description
---------+--------+---------------------------------------
 default | memory | Default memory index for quickstart...
```

## Rollback Procedures

### Understanding Rollback

The migration file includes commented-out rollback commands at the bottom. These are commented for safety to prevent accidental data loss.

### Manual Rollback Steps

**⚠️ WARNING: Rollback will DELETE ALL DATA. Backup first!**

### 1. Backup Database

Before rolling back, always create a backup:

```bash
# Create backup
pg_dump "$DATABASE_URL" > backup_$(date +%Y%m%d_%H%M%S).sql

# Or backup to compressed file
pg_dump "$DATABASE_URL" | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

### 2. Execute Rollback

**Option A: Run the commented rollback section**

The migration file contains rollback commands at the end (lines 248-254). To execute them:

```bash
# Extract and run rollback commands
psql "$DATABASE_URL" <<'SQL'
DROP TABLE memory_usage_log CASCADE;
DROP TABLE memory_relationships CASCADE;
DROP TABLE memories CASCADE;
DROP TABLE memory_indexes CASCADE;
DROP EXTENSION IF EXISTS vector CASCADE;
DROP EXTENSION IF EXISTS pgcrypto CASCADE;
DROP FUNCTION IF EXISTS update_updated_at_column CASCADE;
SQL
```

**Option B: Transaction-based rollback (if caught early)**

If you realize a mistake immediately after running a migration:

```bash
psql "$DATABASE_URL"
```

```sql
-- Start transaction
BEGIN;

-- Run migration
\i migrations/20250117000001_init_postgres_schema.sql

-- Check results
\dt

-- If something is wrong, rollback
ROLLBACK;

-- If everything looks good, commit
COMMIT;
```

**Note**: This only works if you haven't exited psql after running the migration.

## Seed Data (Optional)

Seed data provides sample records for testing and development.

### Run Seed Migration

**⚠️ Note**: Seed data is idempotent and safe to re-run. It uses `ON CONFLICT DO NOTHING` to prevent duplicates.

```bash
# Run seed data
psql "$DATABASE_URL" -f migrations/seeds/01_test_data.sql
```

### What Gets Seeded

The seed file creates:

- **Test indexes**: `youtube-scripts`, `crm-notes`, `personal`
- **Sample memories**: Various memory types (self, belief, episodic, semantic) with test embeddings
- **Test relationships**: Example relationship connections between memories

### Verify Seed Data

```bash
# Check seeded indexes
psql "$DATABASE_URL" -c "SELECT project, name FROM memory_indexes WHERE project='test';"

# Count seeded memories
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM memories WHERE project='test';"

# Check relationships
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM memory_relationships WHERE project='test';"
```

### Remove Seed Data

```bash
# Delete test project data
psql "$DATABASE_URL" <<'SQL'
DELETE FROM memories WHERE project='test';
DELETE FROM memory_indexes WHERE project='test';
SQL
```

## Cloud-Hosted PostgreSQL

Using a cloud provider eliminates local installation complexity and provides managed backups, scaling, and monitoring.

### Neon (Recommended)

[Neon](https://neon.tech/) offers serverless PostgreSQL with excellent pgvector support.

**Setup steps:**

1. Sign up at [https://neon.tech/](https://neon.tech/)
2. Create a new project
3. Enable pgvector extension:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
4. Copy connection string from dashboard (format: `postgresql://user:pass@host/dbname`)
5. Update `config/projects.json` with your Neon connection string:
   ```json
   {
     "production": {
       "databaseUrl": "postgresql://user:pass@ep-xyz.neon.tech/dbname?sslmode=require"
     }
   }
   ```
6. Run migrations using the connection string:
   ```bash
   export DATABASE_URL="postgresql://user:pass@ep-xyz.neon.tech/dbname?sslmode=require"
   psql --dbname "$DATABASE_URL" -f migrations/20250117000001_init_postgres_schema.sql
   ```

**Note**: Neon supports both direct endpoints (`*.neon.tech`) and pooling endpoints (`*.pooler.neon.tech`). Choose the appropriate URL based on your connection pooling needs. The pgvector extension must be created on each branch separately.

**Benefits:**
- Automatic scaling
- Built-in connection pooling
- Free tier available
- pgvector supported out-of-the-box

### Supabase

[Supabase](https://supabase.com/) provides PostgreSQL with an intuitive dashboard and pgvector support.

**Setup steps:**

1. Sign up at [https://supabase.com/](https://supabase.com/)
2. Create a new project
3. Navigate to **SQL Editor** in the dashboard
4. Enable pgvector:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
5. Get connection string from **Settings → Database → Connection String**
6. Update `config/projects.json` (add `?sslmode=require` for secure connections):
   ```json
   {
     "production": {
       "databaseUrl": "postgresql://postgres:password@db.xyz.supabase.co:5432/postgres?sslmode=require"
     }
   }
   ```
7. Run migrations:
   ```bash
   export DATABASE_URL="postgresql://postgres:password@db.xyz.supabase.co:5432/postgres?sslmode=require"
   psql --dbname "$DATABASE_URL" -f migrations/20250117000001_init_postgres_schema.sql
   ```

**Note**: Supabase enforces SSL connections. Use `?sslmode=require` at minimum. For strict certificate verification, use `sslmode=verify-full` with appropriate `sslrootcert` configuration.

**Benefits:**
- Dashboard with SQL editor
- Real-time capabilities (optional)
- Generous free tier
- Built-in authentication and storage (if needed)

### Other Providers

Other PostgreSQL providers with pgvector support:

- **Railway** ([https://railway.app/](https://railway.app/)) - Simple deployment with automatic backups
- **Render** ([https://render.com/](https://render.com/)) - Managed PostgreSQL with pgvector
- **DigitalOcean** - Managed databases with pgvector via extension
- **AWS RDS** - Requires manual pgvector compilation or Aurora Serverless v2

**Note**: Always verify pgvector extension support before choosing a provider. Check their documentation or contact support.

## Troubleshooting

### pgvector Extension Missing

**Error:**
```
ERROR: extension "vector" is not available
```

**Solutions:**

1. **Install pgvector** following platform-specific instructions above
2. **Verify installation:**
   ```bash
   # List available extensions
   psql "$DATABASE_URL" -c "SELECT name FROM pg_available_extensions WHERE name='vector';"
   ```
3. **Check PostgreSQL version** (pgvector requires PostgreSQL 12+):
   ```bash
   psql "$DATABASE_URL" -c "SELECT version();"
   ```
4. **Restart PostgreSQL** after installing pgvector:
   ```bash
   # macOS
   brew services restart postgresql@15

   # Linux
   sudo systemctl restart postgresql

   # Windows
   # Restart via Services app or pg_ctl
   ```

### Permission Errors

**Error:**
```
ERROR: permission denied to create extension "vector"
```

**Solution:**

You need superuser privileges to create extensions:

```bash
# Grant superuser to your user
sudo -u postgres psql -c "ALTER USER your_username WITH SUPERUSER;"

# Or run migration as postgres user
sudo -u postgres psql -d memory_default -f migrations/20250117000001_init_postgres_schema.sql
```

### psql Command Not Found (Windows)

**Error:**
```
'psql' is not recognized as an internal or external command
```

**Solutions:**

1. **Add PostgreSQL to PATH:**
   ```powershell
   # Open PowerShell as Administrator
   $pgPath = "C:\Program Files\PostgreSQL\15\bin"
   [Environment]::SetEnvironmentVariable("Path", "$env:Path;$pgPath", [EnvironmentVariableTarget]::Machine)

   # Restart PowerShell
   ```

2. **Use full path:**
   ```powershell
   & "C:\Program Files\PostgreSQL\15\bin\psql.exe" --dbname "$env:DATABASE_URL" -f migrations\20250117000001_init_postgres_schema.sql
   ```

**Tip**: For paths with spaces or connection strings with special characters, always use the `--dbname` flag to avoid PowerShell parsing issues.

### Connection Refused

**Error:**
```
psql: error: connection to server at "localhost" (::1), port 5432 failed: Connection refused
```

**Solutions:**

1. **Start PostgreSQL service:**
   ```bash
   # macOS
   brew services start postgresql@15

   # Linux
   sudo systemctl start postgresql

   # Windows (PowerShell as Admin)
   Start-Service postgresql-x64-15
   ```

2. **Check if PostgreSQL is running:**
   ```bash
   # macOS/Linux
   pg_isready

   # Check process
   ps aux | grep postgres  # Unix
   Get-Process postgres    # Windows
   ```

3. **Verify port:**
   ```bash
   # Check PostgreSQL listening port
   sudo netstat -tlnp | grep 5432  # Linux
   netstat -an | findstr 5432      # Windows
   ```

### Embedding Dimension Mismatch

**Error:**
```
ERROR: cannot insert embedding: dimension mismatch
```

**Cause:** The schema uses `VECTOR(1536)` for OpenAI's `text-embedding-3-small` model. If you use a different model, dimensions won't match.

**Solutions:**

1. **Use matching model** in `.env`:
   ```bash
   MEMORY_EMBEDDING_MODEL=text-embedding-3-small
   MEMORY_EMBEDDING_DIMENSIONS=1536
   ```

2. **Or modify schema** if using different model (e.g., `text-embedding-3-large` = 3072 dimensions):
   ```sql
   -- In migration file, change line 59:
   embedding VECTOR(3072) NOT NULL,  -- For text-embedding-3-large
   ```

   Then update `.env`:
   ```bash
   MEMORY_EMBEDDING_MODEL=text-embedding-3-large
   MEMORY_EMBEDDING_DIMENSIONS=3072
   ```

### Multiple Environments

**Best practice:** Use separate databases for development, staging, and production.

```json
{
  "local": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/memory_dev"
  },
  "staging": {
    "databaseUrl": "postgresql://user:pass@staging-host:5432/memory_staging"
  },
  "production": {
    "databaseUrl": "postgresql://user:pass@prod-host:5432/memory_prod"
  }
}
```

Set `MEMORY_ACTIVE_PROJECT` environment variable to switch between environments:

```bash
# Development
export MEMORY_ACTIVE_PROJECT=local

# Staging
export MEMORY_ACTIVE_PROJECT=staging

# Production
export MEMORY_ACTIVE_PROJECT=production
```

### Migration Already Applied

If you attempt to re-run a migration, you may see errors like:

```
ERROR: relation "memories" already exists
```

This is expected if the migration was already applied. Options:

1. **Skip if already applied** - migrations are idempotent where possible (uses `IF NOT EXISTS`)
2. **Rollback and re-run** - follow [Rollback Procedures](#rollback-procedures)
3. **Use migration tracking** - consider implementing a migration version table for production use

---

## Additional Resources

- **PostgreSQL Documentation**: [https://www.postgresql.org/docs/](https://www.postgresql.org/docs/)
- **pgvector GitHub**: [https://github.com/pgvector/pgvector](https://github.com/pgvector/pgvector)
- **Memory MCP Project**: See `PROJECT_SPEC.md` and `CLAUDE.md` in repository root
- **OpenAI Embeddings**: [https://platform.openai.com/docs/guides/embeddings](https://platform.openai.com/docs/guides/embeddings)

For issues or questions, please open an issue on the project repository.
