# Deployment Guide

This guide covers deploying the Memory MCP server across various hosting scenarios, from local development to cloud production environments.

## Overview

The Memory MCP server is a Model Context Protocol server that provides semantic memory storage using PostgreSQL with pgvector for vector similarity search. This guide will help you:

- Set up PostgreSQL locally (macOS, Linux, Docker)
- Deploy to cloud PostgreSQL providers (Neon, Supabase, AWS RDS)
- Configure Claude Desktop to use the MCP server
- Optimize for production with connection pooling and backups

**Target audience**: Developers setting up the Memory MCP server for development or production use.

## Prerequisites

Before you begin, ensure you have:

- **PostgreSQL 14+** with pgvector extension support
- **Node.js 18+** for running the MCP server
- **OpenAI API key** for embeddings and LLM orchestration
- **Claude Desktop** (optional, for MCP integration)

## Core Environment Variables

The Memory MCP server is configured through environment variables. Here are the essential settings:

**Required:**

```env
# Backend configuration (Postgres-only stack)
MEMORY_BACKEND=postgres
MEMORY_POSTGRES_PROJECT_REGISTRY=./config/projects.json
MEMORY_ACTIVE_PROJECT=local

# OpenAI API key for embeddings and LLM orchestration
OPENAI_API_KEY=sk-your-api-key-here

# Embedding model (determines vector dimensions)
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

**Optional:**

```env
# Embedding dimensions (auto-detected from model)
MEMORY_EMBEDDING_DIMENSIONS=1536

# Host/system context (inline text or file path)
# Create this file or use inline text to provide system-level context
# MEMORY_MCP_SYSTEM_MESSAGE=./config/memory-host-context.txt
# MEMORY_MCP_SYSTEM_MESSAGE="You are a memory system for a development assistant."

# Debug flags (WARNING: Verbose output, disable in production for performance)
# MEMORY_DEBUG_MODE=true
# MEMORY_DEBUG_OPERATIONS=true
```

See `.env.example` in the repository for a complete list of configuration options.

## Local PostgreSQL Setup

### Option 1: macOS (Homebrew)

Install PostgreSQL and pgvector using Homebrew:

```bash
# Install PostgreSQL 16
brew install postgresql@16

# Start PostgreSQL service
brew services start postgresql@16

# Install pgvector extension
brew install pgvector
```

After installation, run the automated setup script:

```bash
cd memory-mcp
./scripts/setup-postgres.sh
```

The script will:
- Create the `memory_default` database
- Enable the pgvector extension
- Run schema migrations
- Verify the setup

**Manual setup alternative:**

```bash
# Create database
createdb memory_default

# Enable pgvector extension
psql -d memory_default -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run migrations
psql -d memory_default -f migrations/20250117000001_init_postgres_schema.sql
```

**Verification:**

```bash
# Check database exists
psql -U postgres -c "SELECT datname FROM pg_database WHERE datname = 'memory_default';"

# Verify pgvector extension
psql -d memory_default -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# Check tables were created
psql -d memory_default -c "\dt"
```

Expected output: `memories`, `memory_indexes`, `memory_relationships`, `memory_usage_log` tables.

### Option 2: Ubuntu/Debian (apt)

Install PostgreSQL and build pgvector from source:

```bash
# Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Install build tools for pgvector
sudo apt install build-essential postgresql-server-dev-all git

# Build and install pgvector from source
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install
cd ..
```

Create the database and run migrations:

```bash
# Switch to postgres user
sudo -u postgres psql

# In psql:
CREATE DATABASE memory_default;
\c memory_default
CREATE EXTENSION IF NOT EXISTS vector;
\q

# Run migrations
npm run migrate  # Recommended: runs all migrations
# Or manually: psql -U postgres -d memory_default -f migrations/20250117000001_init_postgres_schema.sql
```

**Alternative: Use PostgreSQL apt repository for pgvector**

Some PostgreSQL versions support pgvector as a package:

```bash
# For PostgreSQL 16
sudo apt install postgresql-16-pgvector
```

### Option 3: Docker

Use the official pgvector Docker image for quick setup:

```bash
# Run PostgreSQL with pgvector
docker run -d \
  --name postgres-memory \
  -e POSTGRES_DB=memory_default \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  ankane/pgvector:latest

# Enable pgvector extension
docker exec -it postgres-memory psql -U postgres -d memory_default \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run migrations (from host with connection to Docker DB)
npm run migrate  # Recommended if npm is available on host

# Or apply migrations from inside container
docker exec -i postgres-memory psql -U postgres -d memory_default \
  < migrations/20250117000001_init_postgres_schema.sql
```

**Verify Docker setup:**

```bash
# Connect to database
docker exec -it postgres-memory psql -U postgres -d memory_default

# In psql:
\dt                                    # List tables
SELECT * FROM pg_extension WHERE extname = 'vector';  # Verify pgvector
\q
```

**Troubleshooting tips:**

| Issue | Solution |
|-------|----------|
| pgvector extension not found | Verify `vector.control` exists in `pg_config --sharedir/extension/` |
| Permission denied for CREATE EXTENSION | Connect as superuser: `psql -U postgres -d memory_default` |
| PostgreSQL not running | Start service: `brew services start postgresql@16` (macOS) or `sudo systemctl start postgresql` (Linux) |
| Cannot connect to database | Check connection string in `config/projects.json` matches your setup |

## Cloud PostgreSQL Options

### Neon

[Neon](https://neon.tech) provides serverless PostgreSQL with built-in pgvector support and autoscaling.

**Setup steps:**

1. **Create project**
   - Go to [console.neon.tech](https://console.neon.tech)
   - Create a new project
   - Select your region (choose closest to your users)

2. **Enable pgvector**
   - Open the SQL Editor in Neon dashboard
   - Run:
     ```sql
     CREATE EXTENSION IF NOT EXISTS vector;
     ```

3. **Run migrations**
   - Option A: Use npm script (recommended): `npm run migrate` with connection string in `config/projects.json`
   - Option B: Copy the contents of `migrations/20250117000001_init_postgres_schema.sql` into SQL Editor and execute

4. **Configure connection**
   - Copy your connection string from project dashboard
   - Add to `config/projects.json`:
     ```json
     {
       "production": {
         "databaseUrl": "postgresql://user:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require"
       }
     }
     ```
   - Set `MEMORY_ACTIVE_PROJECT=production` in `.env`

**Production tips:**
- Enable autoscaling to handle variable load
- Use Neon branches for staging/testing environments
- Configure connection pooling (see [Production Considerations](#production-considerations))
- Monitor usage in Neon dashboard

**Cost considerations:**
- Free tier: 0.5 GB storage, 3 GiB-month compute
- Pro tier: Autoscaling, branch management, higher limits

### Supabase

[Supabase](https://supabase.com) includes PostgreSQL with pgvector by default.

**Setup steps:**

1. **Create project**
   - Go to [app.supabase.com](https://app.supabase.com)
   - Create a new project
   - Choose your region
   - Set a strong database password

2. **Enable pgvector**
   - Navigate to SQL Editor
   - Run:
     ```sql
     CREATE EXTENSION IF NOT EXISTS vector;
     ```

3. **Run migrations**
   - Option A: Use npm script (recommended): `npm run migrate` with connection string in `config/projects.json`
   - Option B: In SQL Editor, paste contents of all migration files from `migrations/` directory and execute

4. **Configure connection**
   - Go to Project Settings → Database
   - Copy the connection string (use "Connection pooling" for production)
   - Add to `config/projects.json`:
     ```json
     {
       "production": {
         "databaseUrl": "postgresql://postgres:your-password@db.xxxxxxxxxxxx.supabase.co:5432/postgres"
       }
     }
     ```

**Production tips:**
- Use connection pooling (port 6543) for production workloads
- Enable Row Level Security (RLS) if exposing database directly
- Use Supabase CLI for local development workflow
- Monitor query performance in dashboard

**Cost considerations:**
- Free tier: 500 MB database, 2 GB bandwidth
- Pro tier: 8 GB database, 250 GB bandwidth

### AWS RDS for PostgreSQL

AWS RDS provides managed PostgreSQL with high availability options.

**Setup steps:**

1. **Create RDS instance**
   - Go to AWS RDS Console
   - Create database → PostgreSQL
   - Select PostgreSQL version 14+ (recommend 16)
   - Choose instance class (t3.micro for development, t3.medium+ for production)
   - Enable Multi-AZ for production high availability

2. **Configure security**
   - Set up VPC security group to allow port 5432 from your application
   - Enable SSL connections (default)
   - Create master username and password

3. **Install pgvector**
   - Connect to RDS instance:
     ```bash
     psql -h your-instance.region.rds.amazonaws.com -U postgres -d postgres
     ```
   - Install pgvector:
     ```sql
     CREATE EXTENSION IF NOT EXISTS vector;
     ```

4. **Create database and run migrations**
   ```sql
   CREATE DATABASE memory_default;
   \c memory_default
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

   Then run migrations:
   ```bash
   # Recommended: Use npm script
   npm run migrate

   # Or manually apply migrations
   psql -h your-instance.region.rds.amazonaws.com -U postgres -d memory_default \
     -f migrations/20250117000001_init_postgres_schema.sql
   ```

5. **Configure connection**
   - Add to `config/projects.json`:
     ```json
     {
       "production": {
         "databaseUrl": "postgresql://username:password@your-instance.region.rds.amazonaws.com:5432/memory_default?sslmode=require"
       }
     }
     ```

**Production tips:**
- Enable automated backups with 7-35 day retention
- Use Parameter Groups to tune PostgreSQL settings
- Enable Performance Insights for query monitoring
- Set up CloudWatch alarms for connection count and CPU usage
- Use Read Replicas for read-heavy workloads

**Cost considerations:**
- t3.micro: ~$15/month (development)
- t3.medium: ~$60/month (small production)
- Storage: $0.115/GB-month
- Backup storage: $0.095/GB-month

### Other PostgreSQL Providers

Any PostgreSQL 14+ provider with pgvector support will work. Here's a checklist:

**Requirements:**
- [ ] PostgreSQL version 14 or higher
- [ ] pgvector extension available (either pre-installed or can be compiled)
- [ ] Connection via standard PostgreSQL connection string
- [ ] SSL/TLS support (recommended for production)

**Compatible providers:**
- **Google Cloud SQL for PostgreSQL** - Managed PostgreSQL with pgvector
- **Azure Database for PostgreSQL** - Flexible Server with extensions
- **DigitalOcean Managed Databases** - PostgreSQL with extension support
- **Railway** - Quick deployment with PostgreSQL + pgvector
- **Self-hosted** - Any server running PostgreSQL 14+

**General setup pattern:**
1. Create PostgreSQL instance with version 14+
2. Enable pgvector extension: `CREATE EXTENSION IF NOT EXISTS vector;`
3. Run migrations from `migrations/` directory
4. Update `config/projects.json` with connection string
5. Test connection and verify tables exist

## Local Development Workflow

Standard development loop for working with the Memory MCP server:

### Initial Setup

```bash
# 1. Clone repository
git clone <repository-url>
cd memory-mcp

# 2. Install dependencies
npm install

# 3. Set up database (choose one method from above)
./scripts/setup-postgres.sh  # Automated setup
# OR manually create database and run migrations

# 4. Configure environment
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
```

### Development Commands

```bash
# Run server in development mode (hot reload with tsx)
npm run dev

# Build for production (compiles TypeScript to dist/)
npm run build

# Run compiled server (production mode)
npm start

# Code quality checks
npm run lint           # Check linting issues
npm run lint:fix       # Auto-fix linting issues
npm run format         # Format code with Prettier
npm run format:check   # Check if code is formatted

# Database operations
npm run migrate        # Run migrations
npm run migrate:seed   # Load test data (optional)
npm run migrate:verify # Verify database setup
```

### Multi-Project Development

The server supports multiple isolated projects through `config/projects.json`:

```json
{
  "local": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/memory_default"
  },
  "staging": {
    "databaseUrl": "postgresql://user:pass@staging-host:5432/memory_staging"
  },
  "production": {
    "databaseUrl": "postgresql://user:pass@prod-host:5432/memory_prod"
  }
}
```

Switch between projects using the `MEMORY_ACTIVE_PROJECT` environment variable:

```bash
# Development
MEMORY_ACTIVE_PROJECT=local npm run dev

# Staging
MEMORY_ACTIVE_PROJECT=staging npm run dev

# Production
MEMORY_ACTIVE_PROJECT=production npm start
```

### Resetting the Database

To start fresh during development:

```bash
# Using setup script (will prompt for confirmation)
./scripts/setup-postgres.sh

# Manual reset
psql -U postgres -c "DROP DATABASE memory_default;"
psql -U postgres -c "CREATE DATABASE memory_default;"
psql -d memory_default -c "CREATE EXTENSION IF NOT EXISTS vector;"
npm run migrate  # Runs all migrations
```

## Claude Desktop MCP Configuration

Configure Claude Desktop to use the Memory MCP server for persistent memory.

### Build for Production

Claude Desktop requires compiled JavaScript (not TypeScript):

```bash
# Build the project
npm run build

# Verify dist/ directory was created
ls -la dist/
```

### Configure Claude Desktop

Locate your Claude Desktop configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the Memory MCP server configuration:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/memory-mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-your-api-key-here",
        "MEMORY_ACTIVE_PROJECT": "local",
        "MEMORY_BACKEND": "postgres",
        "MEMORY_POSTGRES_PROJECT_REGISTRY": "/absolute/path/to/memory-mcp/config/projects.json",
        "MEMORY_EMBEDDING_MODEL": "text-embedding-3-small"
      }
    }
  }
}
```

**Important notes:**
- Use absolute paths for `args` and environment variables
- The `command` is `node` (not `npm` or `tsx`)
- Point to `dist/index.js` (compiled), not `src/index.ts`
- Include all required environment variables in the `env` block

### Testing the Configuration

1. **Restart Claude Desktop** to load the new configuration

2. **Test basic commands** in Claude:
   - "Remember that I prefer dark mode"
   - "What do you remember about my preferences?"
   - "List my memory indexes"

3. **Check for errors**:
   - macOS: `~/Library/Logs/Claude/mcp*.log`
   - Windows: `%APPDATA%\Claude\logs\mcp*.log`

### Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP server not responding | Verify path in config is absolute and points to `dist/index.js` |
| Permission denied | Ensure `dist/index.js` is executable: `chmod +x dist/index.js` |
| Environment variables not set | Use absolute paths in env vars (e.g., `MEMORY_POSTGRES_PROJECT_REGISTRY`) |
| STDIO timeout | Check server starts successfully: `node dist/index.js` should run without errors |
| Database connection fails | Verify `config/projects.json` connection string is correct |

### Development vs Production Mode

For development with hot reload:

```json
{
  "command": "npm",
  "args": ["run", "dev"],
  "cwd": "/absolute/path/to/memory-mcp"
}
```

For production (recommended):

```json
{
  "command": "node",
  "args": ["/absolute/path/to/memory-mcp/dist/index.js"]
}
```

## Environment-Specific Configuration

### Embedding Models

Choose the embedding model based on quality vs cost trade-offs:

```env
# Small model (default, recommended)
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
MEMORY_EMBEDDING_DIMENSIONS=1536

# Large model (higher quality, higher cost)
MEMORY_EMBEDDING_MODEL=text-embedding-3-large
MEMORY_EMBEDDING_DIMENSIONS=3072
```

**Important**: The embedding dimension must match your database schema. The default migration uses `vector(1536)` for `text-embedding-3-small`. If you change models, update the migration:

```sql
-- For text-embedding-3-small (1536 dimensions)
embedding vector(1536)

-- For text-embedding-3-large (3072 dimensions)
embedding vector(3072)
```

Then re-run migrations on a fresh database.

### Debug Flags

Enable detailed logging for development:

```env
# General debug logging
MEMORY_DEBUG_MODE=true

# Operation lifecycle logging
MEMORY_DEBUG_OPERATIONS=true

# Validation step details
MEMORY_DEBUG_VALIDATION=true

# Access tracking and priority updates
MEMORY_DEBUG_ACCESS_TRACKING=true

# Repository-level operations
MEMORY_DEBUG_REPOSITORY=true

# Query expansion diagnostics
MEMORY_DEBUG_QUERY_EXPANSION=true
```

**Production**: Disable all debug flags for performance and clean logs.

### Refinement Tuning

Control memory lifecycle and cleanup behavior:

```env
# Maximum refinement actions per operation
MEMORY_REFINE_DEFAULT_BUDGET=100

# Allow DELETE actions in refinement (use cautiously)
MEMORY_REFINE_ALLOW_DELETE=false

# Enable automatic access tracking
MEMORY_ACCESS_TRACKING_ENABLED=true

# Number of top memories to boost on access
MEMORY_ACCESS_TRACKING_TOP_N=3

# Priority boost amount per access
MEMORY_ACCESS_PRIORITY_BOOST=0.01

# Enable semantic query expansion
MEMORY_QUERY_EXPANSION_ENABLED=true

# Number of expansion queries to generate
MEMORY_QUERY_EXPANSION_COUNT=2
```

### File Ingestion Limits

Tune chunking behavior for large file ingestion:

```env
# Files larger than this use chunking (bytes)
MEMORY_LARGE_FILE_THRESHOLD_BYTES=262144  # 256 KB

# Characters per chunk
MEMORY_CHUNK_CHAR_LENGTH=16000

# Overlap between chunks
MEMORY_CHUNK_CHAR_OVERLAP=2000

# Maximum chunks per file
MEMORY_MAX_CHUNKS_PER_FILE=24

# Maximum memories extracted per file
MEMORY_MAX_MEMORIES_PER_FILE=50
```

### Security Configuration

**Never commit secrets to version control:**

```bash
# Create .env file (not tracked)
cp .env.example .env

# Verify .env is in .gitignore (already included in template)
grep -q "^\.env$" .gitignore && echo ".env is ignored" || echo ".env" >> .gitignore
```

**Use secrets managers in production:**

- **AWS**: Use Secrets Manager or Parameter Store
- **Heroku**: Use Config Vars
- **Docker**: Use secrets or environment files
- **Kubernetes**: Use Secrets resources

**Example: AWS Secrets Manager**

```bash
# Store OpenAI API key
aws secretsmanager create-secret \
  --name memory-mcp/openai-api-key \
  --secret-string "sk-your-api-key"

# Retrieve in application startup script
export OPENAI_API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id memory-mcp/openai-api-key \
  --query SecretString --output text)
```

## Production Considerations

### Connection Pooling

The Memory MCP server uses `PoolManager` (see `src/memory/PoolManager.ts`) for efficient connection management:

**Key behaviors:**
- **One pool per database URL**: Connections are reused across operations
- **Automatic cleanup**: Pools close gracefully on shutdown (SIGINT/SIGTERM)
- **Configurable limits**: Default 10 max connections, 30s idle timeout
- **Error handling**: Pool errors are logged and recovered

**Production tuning:**

The default pool configuration in `src/memory/PoolManager.ts` is:

```typescript
{
  max: 10,                        // Maximum connections per pool
  idleTimeoutMillis: 30000,       // Close idle connections after 30s
  connectionTimeoutMillis: 10000  // Fail new connections after 10s
}
```

**Note**: These limits are currently hard-coded in `PoolManager.ts`. To modify them, you must edit the source code directly. Future versions may expose environment-based configuration.

**Multi-project warning**: PoolManager creates a separate pool per database URL. If you run 3 projects simultaneously, you'll consume up to 30 backend connections (3 projects × 10 max connections). Size your database connection limits accordingly, especially on providers like Neon free tier (limited connections) or Supabase.

For high-traffic production deployments, consider:

1. **Use PgBouncer** for connection pooling at the database level:
   ```bash
   # Install PgBouncer
   sudo apt install pgbouncer

   # Configure pgbouncer.ini
   [databases]
   memory_default = host=localhost dbname=memory_default

   [pgbouncer]
   pool_mode = transaction
   max_client_conn = 100
   default_pool_size = 20
   ```

2. **Neon/Supabase**: Use built-in connection pooling:
   - Neon: Use the `-pooler` endpoint (e.g., `ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech`) instead of the direct endpoint
   - Supabase: Use port 6543 (connection pooling mode) instead of 5432 (direct connection)

3. **Monitor pool usage**:
   ```bash
   # Check active connections
   psql -d memory_default -c "SELECT count(*) FROM pg_stat_activity;"
   ```

### Scaling Strategies

**Vertical scaling (single instance):**
- Increase PostgreSQL instance size (CPU/RAM)
- Optimize indexes and query performance
- Tune `max` pool size based on load

**Horizontal scaling (multiple instances):**
- Run multiple MCP server instances (stateless)
- Use load balancer for distribution
- Share single PostgreSQL backend (connection pooling critical)

**Database scaling:**
- **Read replicas**: Offload read-heavy workloads (Neon/RDS)
- **Autoscaling**: Use Neon's serverless autoscaling
- **Partitioning**: Partition `memories` table by timestamp for large datasets

### Backups & Migrations

**Automated backups:**

- **Neon**: Automatic continuous backups, point-in-time recovery
- **Supabase**: Daily backups on Pro tier, configure retention
- **AWS RDS**: Configure automated backups (7-35 day retention):
  ```bash
  aws rds modify-db-instance \
    --db-instance-identifier memory-prod \
    --backup-retention-period 30 \
    --preferred-backup-window "03:00-04:00"
  ```
- **Self-hosted**: Use `pg_dump` with cron:
  ```bash
  # Daily backup script
  pg_dump -U postgres -d memory_default | gzip > backup-$(date +%Y%m%d).sql.gz

  # Retain last 30 days
  find /backups -name "backup-*.sql.gz" -mtime +30 -delete
  ```

**Migration workflow:**

Before deploying schema changes:

```bash
# 1. Backup production database
pg_dump -h prod-host -U postgres -d memory_default > backup.sql

# 2. Test migration on staging
psql -h staging-host -U postgres -d memory_staging -f migrations/new_migration.sql

# 3. Verify staging application works
MEMORY_ACTIVE_PROJECT=staging npm start

# 4. Run migration on production (during maintenance window)
psql -h prod-host -U postgres -d memory_default -f migrations/new_migration.sql

# 5. Verify with migration:verify script
MEMORY_ACTIVE_PROJECT=production npm run migrate:verify
```

**Rollback plan:**

```bash
# Restore from backup if migration fails
psql -h prod-host -U postgres -d memory_default < backup.sql
```

### High Availability

**Database layer:**
- **Multi-AZ deployment** (AWS RDS): Automatic failover
- **Neon**: Built-in redundancy across availability zones
- **Supabase**: High availability on Pro tier

**Application layer:**
- Deploy multiple MCP server instances behind load balancer
- Use health checks to detect failed instances
- Implement graceful shutdown with connection draining

**Monitoring & Alerting:**

Set up monitoring for:
- Database connection count approaching pool limit
- Query latency (p95, p99)
- Error rates in application logs
- Disk space usage on database server
- Memory/CPU utilization

**Example: CloudWatch alarms for RDS**

```bash
# Alert when connection count > 80% of max
aws cloudwatch put-metric-alarm \
  --alarm-name memory-rds-high-connections \
  --metric-name DatabaseConnections \
  --namespace AWS/RDS \
  --statistic Average \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 8 \
  --comparison-operator GreaterThanThreshold
```

### Observability

**Application logging:**

The server logs operations when debug flags are enabled. In production:

```env
# Minimal logging (errors only)
MEMORY_DEBUG_MODE=false
MEMORY_DEBUG_OPERATIONS=false
```

**Structured logging** (recommended for production):

Consider adding a logging library like `pino`:

```bash
npm install pino
```

**Database query performance:**

```sql
-- Enable pg_stat_statements for query analytics
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- View slowest queries
SELECT
  query,
  calls,
  total_exec_time,
  mean_exec_time
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

**Metrics to track:**
- Memory creation rate (memories/hour)
- Search query latency (ms)
- Embedding generation time (ms)
- Pool connection utilization (%)
- Database size growth (MB/day)

## Quick Reference

### Essential Commands

| Task | Command |
|------|---------|
| Install dependencies | `npm install` |
| Run development server | `npm run dev` |
| Build for production | `npm run build` |
| Run production server | `npm start` |
| Setup local database | `./scripts/setup-postgres.sh` |
| Run migrations | `npm run migrate` |
| Verify database | `npm run migrate:verify` |
| Format code | `npm run format` |
| Check linting | `npm run lint` |
| Auto-fix linting issues | `npm run lint:fix` |

### Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MEMORY_BACKEND` | Yes | `postgres` | Backend type (always postgres) |
| `MEMORY_POSTGRES_PROJECT_REGISTRY` | Yes | `./config/projects.json` | Path to projects config |
| `MEMORY_ACTIVE_PROJECT` | Yes | `local` | Active project key from registry |
| `OPENAI_API_KEY` | Yes | - | OpenAI API key for embeddings |
| `MEMORY_EMBEDDING_MODEL` | No | `text-embedding-3-small` | Embedding model to use |
| `MEMORY_EMBEDDING_DIMENSIONS` | No | Auto-detected | Vector dimensions (must match schema) |
| `MEMORY_MCP_SYSTEM_MESSAGE` | No | - | Host context (inline or file path) |
| `MEMORY_DEBUG_MODE` | No | `false` | Enable debug logging |
| `MEMORY_REFINE_DEFAULT_BUDGET` | No | `100` | Max refinement actions |
| `MEMORY_CHUNK_CHAR_LENGTH` | No | `16000` | Chunk size for large files |

### Connection String Examples

```bash
# Local PostgreSQL
postgresql://postgres:postgres@localhost:5432/memory_default

# Neon
postgresql://user:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require

# Supabase
postgresql://postgres:password@db.xxxxxxxxxxxx.supabase.co:5432/postgres

# AWS RDS
postgresql://username:password@your-instance.region.rds.amazonaws.com:5432/memory_default?sslmode=require

# Docker
postgresql://postgres:postgres@localhost:5432/memory_default
```

### Troubleshooting Flowchart

```
Connection Error?
├─ Check PostgreSQL is running
├─ Verify connection string in config/projects.json
└─ Test: psql "<connection-string>"

Extension Error (pgvector)?
├─ Check extension installed: pg_config --sharedir
├─ Reinstall: brew reinstall pgvector (macOS)
└─ Enable: CREATE EXTENSION IF NOT EXISTS vector;

Migration Error?
├─ Verify database exists
├─ Check pgvector enabled
└─ Run: psql -d memory_default -f migrations/*.sql

Embedding Dimension Mismatch?
├─ Check MEMORY_EMBEDDING_MODEL matches schema
├─ Update migration vector(1536) or vector(3072)
└─ Re-run migrations on fresh database

Claude Desktop Not Connecting?
├─ Verify absolute path to dist/index.js
├─ Check env vars set correctly
├─ Test: node dist/index.js (should start without errors)
└─ Check logs: ~/Library/Logs/Claude/mcp*.log
```

### Sample Project Registry

```json
{
  "local": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/memory_default"
  },
  "staging": {
    "databaseUrl": "postgresql://user:pass@staging.postgres.neon.tech/memory_staging?sslmode=require"
  },
  "production": {
    "databaseUrl": "postgresql://user:pass@prod.postgres.neon.tech/memory_prod?sslmode=require"
  }
}
```

### Deployment Checklist

**Pre-deployment:**
- [ ] Run `npm run build` successfully
- [ ] Verify `.env` is not committed (in `.gitignore`)
- [ ] Test migrations on staging environment
- [ ] Run `npm run lint` and `npm run format:check`
- [ ] Backup production database

**Production setup:**
- [ ] PostgreSQL 14+ with pgvector enabled
- [ ] Database migrations applied
- [ ] Connection pooling configured (PgBouncer or provider pooling)
- [ ] Environment variables set (use secrets manager)
- [ ] Automated backups enabled
- [ ] Monitoring and alerting configured
- [ ] Health checks implemented

**Post-deployment:**
- [ ] Verify server starts: `npm start`
- [ ] Test MCP tools via Claude Desktop
- [ ] Check logs for errors
- [ ] Monitor database connections
- [ ] Validate backup restoration procedure

---

For architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md).
For development guidance, see [../CLAUDE.md](../CLAUDE.md).
For migration details, see [../migrations/20250117000001_init_postgres_schema.sql](../migrations/20250117000001_init_postgres_schema.sql).
