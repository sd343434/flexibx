import { resolveTestDatabaseUrl } from "./test-database";

// Point every module that reads configuration (getEnv → getDb/getSystemDb, health
// checks) at the test database before any application module is imported.
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.APP_URL ??= "http://localhost:3000";
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
