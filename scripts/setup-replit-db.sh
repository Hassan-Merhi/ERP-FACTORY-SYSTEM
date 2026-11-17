#!/bin/bash
echo "After deleting the old secrets, run these commands:"
echo ""
echo "1. MIGRATION_CONFIRMATION=APPLY_SCHEMA_MIGRATIONS npm run db:migrate"
echo "2. tsx scripts/create-admin.ts"
echo ""
echo "This will set up the Replit database and create admin user"
