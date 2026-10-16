import { Pool } from "pg";
import { hashPassword } from "../server/routes/helpers/passwordHelpers";

// Use the DATABASE_URL but with SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  const client = await pool.connect();
  
  try {
    console.log('Testing connection to Neon database...');
    await client.query('SELECT NOW()');
    console.log('✅ Connected successfully!\n');
    
    // Check if tables exist
    const tablesCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    
    console.log('Existing tables:', tablesCheck.rows.map(r => r.table_name).join(', ') || 'none');
    
    if (tablesCheck.rows.length > 0) {
      // Try to create admin user
      console.log('\nAttempting to create admin user...');
      try {
        const result = await client.query(
          'INSERT INTO users (username, password, active) VALUES ($1, $2, $3) RETURNING id, username',
          ['admin', await hashPassword('admin'), true]
        );
        console.log('✅ Admin user created:', result.rows[0]);
      } catch (err: any) {
        if (err.code === '23505') {
          console.log('ℹ️  Admin user already exists');
        } else {
          console.error('❌ Error creating user:', err.message);
        }
      }
    } else {
      console.log('\n⚠️  No tables found in database.');
      console.log('Run `npm run db:push` to create tables first.');
    }
    
  } catch (error: any) {
    console.error('❌ Connection failed:', error.message);
    if (error.message?.includes('disabled')) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('⚠️  NEON DATABASE ENDPOINT IS DISABLED');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('\nTo fix this:');
      console.log('1. Go to https://console.neon.tech/');
      console.log('2. Find your project');
      console.log('3. Re-enable the endpoint: ep-dry-hat-afvmpq7l');
      console.log('\nThe endpoint was likely suspended due to inactivity.');
      console.log('Neon free tier suspends databases after some time.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

init();
