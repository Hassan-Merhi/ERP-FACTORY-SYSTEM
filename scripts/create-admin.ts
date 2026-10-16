import { db } from "../server/db";
import { users, companies, userCompanyRoles } from "../shared/schema";
import { hashPassword } from "../server/routes/helpers/passwordHelpers";

async function createAdmin() {
  try {
    console.log('Creating initial admin user and company...\n');

    // 1. Create a company
    console.log('Step 1: Creating company...');
    const [company] = await db.insert(companies).values({
      code: 'MAIN',
      name: 'Main Company',
      active: true,
    }).returning();
    console.log(`✅ Company created: ${company.name} (ID: ${company.id})\n`);

    // 2. Create admin user
    console.log('Step 2: Creating admin user...');
    const username = 'admin';
    const password = 'admin'; // Change this after first login!
    
    const [user] = await db.insert(users).values({
      username,
      password: await hashPassword(password),
      active: true,
    }).returning();
    console.log(`✅ Admin user created (ID: ${user.id})\n`);

    // 3. Assign admin role to the user for this company
    console.log('Step 3: Assigning Admin role...');
    const [role] = await db.insert(userCompanyRoles).values({
      userId: user.id,
      companyId: company.id,
      role: 'Admin',
    }).returning();
    console.log(`✅ Admin role assigned\n`);

    console.log('════════════════════════════════════════');
    console.log('🎉 Setup Complete!');
    console.log('════════════════════════════════════════');
    console.log('\nYou can now log in with the configured admin account.');
    console.log('\n⚠️  IMPORTANT: Change the default password after first login!\n');
    console.log('Your company details:');
    console.log(`  Company: ${company.name}`);
    console.log(`  Code: ${company.code}`);
    console.log('════════════════════════════════════════\n');

  } catch (error: any) {
    if (error.message?.includes('duplicate key')) {
      console.error('\n❌ Error: Admin user or company already exists!');
      console.error('   If you need to reset, delete the existing data first.\n');
    } else {
      console.error('\n❌ Error creating admin:', error.message);
    }
    process.exit(1);
  }

  process.exit(0);
}

createAdmin();
