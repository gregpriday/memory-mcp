#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Database configuration
DB_NAME="memory_default"
DB_USER="${POSTGRES_USER:-postgres}"
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"

echo -e "${GREEN}Memory MCP - PostgreSQL Setup Script${NC}"
echo "========================================"
echo ""

# Function to check if PostgreSQL is installed
check_postgres() {
    echo -n "Checking PostgreSQL installation... "
    if command -v psql &> /dev/null; then
        POSTGRES_VERSION=$(psql --version | awk '{print $3}')
        echo -e "${GREEN}✓${NC} Found PostgreSQL $POSTGRES_VERSION"
        return 0
    else
        echo -e "${RED}✗${NC} PostgreSQL not found"
        return 1
    fi
}

# Function to check if PostgreSQL is running
check_postgres_running() {
    echo -n "Checking PostgreSQL is running... "
    # Try pg_isready first, fall back to psql if not available
    if command -v pg_isready &> /dev/null; then
        if pg_isready -h "$DB_HOST" -p "$DB_PORT" &> /dev/null; then
            echo -e "${GREEN}✓${NC} PostgreSQL is running"
            return 0
        else
            echo -e "${RED}✗${NC} PostgreSQL is not running"
            return 1
        fi
    else
        # Fallback: try a lightweight psql connection
        if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -c '\q' &> /dev/null; then
            echo -e "${GREEN}✓${NC} PostgreSQL is running"
            return 0
        else
            echo -e "${RED}✗${NC} PostgreSQL is not running"
            return 1
        fi
    fi
}

# Function to check if database exists
check_database_exists() {
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"
}

# Function to create database
create_database() {
    echo -n "Creating database '$DB_NAME'... "
    if check_database_exists; then
        echo -e "${YELLOW}⚠${NC}  Database already exists"
        echo -e "${YELLOW}WARNING:${NC} You are about to drop database '$DB_NAME' on $DB_HOST:$DB_PORT"
        read -p "Do you want to drop and recreate it? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo -n "Type the database name '$DB_NAME' to confirm: "
            read -r CONFIRM_NAME
            if [ "$CONFIRM_NAME" = "$DB_NAME" ]; then
                psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -c "DROP DATABASE $DB_NAME;" > /dev/null
                psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -c "CREATE DATABASE $DB_NAME;" > /dev/null
                echo -e "${GREEN}✓${NC} Database recreated"
            else
                echo -e "${RED}✗${NC} Database name mismatch - aborting"
                exit 1
            fi
        else
            echo -e "${YELLOW}⚠${NC}  Using existing database"
        fi
    else
        psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -c "CREATE DATABASE $DB_NAME;" > /dev/null
        echo -e "${GREEN}✓${NC} Database created"
    fi
}

# Function to enable pgvector extension
enable_pgvector() {
    echo -n "Enabling pgvector extension... "
    ERROR_OUTPUT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1)
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} pgvector enabled"
        return 0
    else
        echo -e "${RED}✗${NC} Failed to enable pgvector"
        echo -e "${YELLOW}Error details:${NC}"
        echo "$ERROR_OUTPUT"
        echo ""
        echo -e "${YELLOW}Note:${NC} You may need to install pgvector first:"
        echo "  macOS:   brew install pgvector"
        echo "  Linux:   See README.md for installation instructions"
        return 1
    fi
}

# Function to run migrations
run_migrations() {
    echo "Running schema migrations..."

    # Check if migrations directory exists
    if [ ! -d "migrations" ]; then
        echo -e "${RED}✗${NC} Migrations directory not found"
        return 1
    fi

    # Find all .sql files in migrations directory (excluding seeds)
    MIGRATION_FILES=$(find migrations -maxdepth 1 -name "*.sql" -type f | sort)

    if [ -z "$MIGRATION_FILES" ]; then
        echo -e "${YELLOW}⚠${NC}  No migration files found"
        return 0
    fi

    # Run each migration file
    for MIGRATION_FILE in $MIGRATION_FILES; do
        echo -n "  Running $(basename "$MIGRATION_FILE")... "
        ERROR_OUTPUT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$MIGRATION_FILE" 2>&1)
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓${NC}"
        else
            echo -e "${RED}✗${NC} Migration failed"
            echo -e "${YELLOW}Error details:${NC}"
            echo "$ERROR_OUTPUT"
            return 1
        fi
    done

    echo -e "${GREEN}✓${NC} All migrations completed"
    return 0
}

# Function to verify setup
verify_setup() {
    echo ""
    echo "Verifying setup..."
    echo "-------------------"

    # Check pgvector extension
    echo -n "  pgvector extension: "
    PGVECTOR_CHECK=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'vector';" 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$PGVECTOR_CHECK" ] && [ "$PGVECTOR_CHECK" -eq 1 ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
    fi

    # Check tables
    echo -n "  Tables created: "
    TABLE_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('memories', 'memory_indexes', 'memory_relationships', 'memory_usage_log');" 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$TABLE_COUNT" ] && [ "$TABLE_COUNT" -eq 4 ]; then
        echo -e "${GREEN}✓${NC} (4/4)"
    elif [ -n "$TABLE_COUNT" ]; then
        echo -e "${YELLOW}⚠${NC}  ($TABLE_COUNT/4)"
    else
        echo -e "${RED}✗${NC}  (query failed)"
    fi

    # Check default index
    echo -n "  Default index: "
    INDEX_CHECK=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM memory_indexes WHERE name = 'memory';" 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$INDEX_CHECK" ] && [ "$INDEX_CHECK" -ge 1 ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}⚠${NC}"
    fi
}

# Main execution
main() {
    # Check prerequisites
    if ! check_postgres; then
        echo -e "${RED}Error:${NC} PostgreSQL is not installed"
        echo "Please install PostgreSQL 14+ before running this script."
        exit 1
    fi

    if ! check_postgres_running; then
        echo -e "${RED}Error:${NC} PostgreSQL is not running"
        echo "Please start PostgreSQL before running this script."
        echo ""
        echo "macOS (Homebrew):  brew services start postgresql"
        echo "Linux (systemd):   sudo systemctl start postgresql"
        echo "Docker:            docker start postgres-memory"
        exit 1
    fi

    echo ""

    # Setup steps
    create_database
    enable_pgvector || exit 1
    run_migrations || exit 1

    # Verify
    verify_setup

    echo ""
    echo -e "${GREEN}✓ Setup complete!${NC}"
    echo ""
    echo "Connection string:"
    echo "  postgresql://$DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
    echo ""
    echo "Next steps:"
    echo "  1. Copy .env.example to .env"
    echo "  2. Set your OPENAI_API_KEY in .env"
    echo "  3. Run 'npm install' to install dependencies"
    echo "  4. Run 'npm run dev' to start the server"
    echo ""
}

# Run main function
main
