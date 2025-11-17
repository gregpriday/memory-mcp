# Memory MCP Server

A Model Context Protocol (MCP) server for semantic memory storage using PostgreSQL with pgvector for vector similarity search.

## Prerequisites

- **PostgreSQL 14+** - Database server with vector extension support
- **Node.js 18+** - Runtime environment
- **OpenAI API Key** - For generating embeddings

## Quick Start

### Automated Setup (Recommended)

Run the setup script to automatically create the database, enable pgvector, and run migrations:

```bash
./scripts/setup-postgres.sh
```

The script will:
- Check if PostgreSQL is installed and running
- Create the `memory_default` database
- Enable the pgvector extension
- Run schema migrations
- Verify the setup

### Manual Setup

If you prefer to set up manually, follow these steps:

### 1. Install PostgreSQL with pgvector

#### macOS (Homebrew)

```bash
# Install PostgreSQL 14 or later
brew install postgresql@16

# Start PostgreSQL service
brew services start postgresql@16

# Install pgvector
brew install pgvector
```

#### Linux (Ubuntu/Debian)

```bash
# Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib

# Install build tools for pgvector
# Note: Replace 'all' with your version number if you want version-specific dev package
sudo apt install build-essential postgresql-server-dev-all

# Install pgvector from source
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install
```

#### Docker

```bash
# Use the official pgvector image with memory_default database
docker run -d \
  --name postgres-memory \
  -e POSTGRES_DB=memory_default \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  ankane/pgvector:latest

# Enable pgvector extension
docker exec -it postgres-memory psql -U postgres -d memory_default -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run migrations
docker exec -i postgres-memory psql -U postgres -d memory_default < migrations/20250117000001_init_postgres_schema.sql
```

### 2. Create Database

```bash
# Create the memory_default database
createdb memory_default

# Or using psql
psql -U postgres -c "CREATE DATABASE memory_default;"
```

### 3. Enable pgvector Extension

```bash
# Connect to the database and enable the extension
psql -d memory_default -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 4. Run Migrations

```bash
# Run the schema migration
psql -d memory_default -f migrations/20250117000001_init_postgres_schema.sql

# Optional: Load test data
psql -d memory_default -f migrations/seeds/01_test_data.sql
```

### 5. Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env and set your configuration
# - Set your OPENAI_API_KEY
# - Verify config/projects.json points to memory_default (already configured)
```

Example `.env`:

```env
MEMORY_POSTGRES_PROJECT_REGISTRY=./config/projects.json
MEMORY_ACTIVE_PROJECT=local
OPENAI_API_KEY=sk-your-api-key-here
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

The database connection is configured in `config/projects.json`:

```json
{
  "local": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/memory_default"
  }
}
```

### 6. Verify Installation

Run these commands to verify your setup:

```bash
# Verify memory_default database exists
psql -U postgres -c "SELECT datname FROM pg_database WHERE datname = 'memory_default';"

# Check PostgreSQL connection
psql -d memory_default -c "SELECT version();"

# Verify pgvector extension is enabled
psql -d memory_default -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# Check that tables were created
psql -d memory_default -c "\dt"

# Verify the schema
psql -d memory_default -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"
```

Expected output should show:
- Database `memory_default` exists
- PostgreSQL version (14+)
- pgvector extension in the extensions list
- Tables: `memories`, `memory_indexes`, `memory_relationships`, `memory_usage_log`

## Development

### Install Dependencies

```bash
npm install
```

### Run Development Server

```bash
npm run dev
```

### Build for Production

```bash
npm run build
npm start
```

### Code Quality

```bash
# Check linting
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

## Architecture

This MCP server uses a PostgreSQL backend with pgvector for semantic similarity search:

- **Vector Storage**: Embeddings stored as `vector(1536)` for `text-embedding-3-small`
- **Semantic Search**: pgvector's ivfflat index for fast similarity queries
- **Multi-Project**: Isolated databases per project via `config/projects.json`
- **Memory Lifecycle**: Dynamic priority scoring with decay and access tracking

## Configuration

### Database Connection

The server uses `config/projects.json` to map project IDs to database URLs:

```json
{
  "local": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/memory_default"
  }
}
```

Active project is selected via `MEMORY_ACTIVE_PROJECT` environment variable.

### Embedding Models

Supported models (configured via `MEMORY_EMBEDDING_MODEL`):

- `text-embedding-3-small` - 1536 dimensions (default)
- `text-embedding-3-large` - 3072 dimensions

**Important**: If you change the embedding model, you must update the `embedding` column type in the migration to match the new dimension.

## Troubleshooting

### pgvector extension not found

```bash
# Verify pgvector is installed
pg_config --sharedir
# Check if vector.control exists in <sharedir>/extension/

# Reinstall if needed (macOS)
brew reinstall pgvector

# Reinstall if needed (Linux)
cd pgvector && sudo make install
```

### Cannot connect to database

```bash
# Check PostgreSQL is running
psql -U postgres -l

# Check connection string in config/projects.json
# Verify username, password, host, and port
```

### Permission denied for CREATE EXTENSION

```bash
# Connect as superuser
psql -U postgres -d memory_default -c "CREATE EXTENSION vector;"
```

## Cloud Deployment

### Neon

[Neon](https://neon.tech) provides serverless PostgreSQL with pgvector support:

1. Create a new project at console.neon.tech
2. Enable pgvector in the SQL Editor:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Copy the connection string to `config/projects.json`

### Supabase

[Supabase](https://supabase.com) includes pgvector by default:

1. Create a new project at app.supabase.com
2. Go to SQL Editor and run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Copy the connection string from Project Settings → Database

## License

Private - Internal use only
