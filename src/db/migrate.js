import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Get connection string from environment or use default
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/game_economy';

const pool = new Pool({ connectionString });

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('Running database migrations...');

        const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
        await client.query(schema);

        console.log('Migrations completed successfully!');
    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch(err => { console.error(err); process.exit(1); });
