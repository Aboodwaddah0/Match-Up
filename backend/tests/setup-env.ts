import dotenv from 'dotenv';
import { toTestUrl } from './helpers/db-url';

dotenv.config({ quiet: true });

process.env.DATABASE_URL = toTestUrl(process.env.DATABASE_URL ?? 'postgresql://fym:fym_dev_password@localhost:5433/fym');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.APP_URL = 'http://app.test';
process.env.MAIL_OUTBOX_ENCRYPTION_KEY = Buffer.from('test-only-mail-key-test-only-012').toString('base64url');
