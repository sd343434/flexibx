import "dotenv/config";

/**
 * Resolves the integration-test database and refuses anything that could be a real
 * database: it must be set explicitly and its name must end in `_test`. Tests TRUNCATE
 * tables, so this guard is a hard safety requirement.
 */
export function resolveTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (url === undefined || url === "") {
    throw new Error(
      "TEST_DATABASE_URL is not set (see .env.example). Integration tests need a dedicated database.",
    );
  }
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to run integration tests: database "${databaseName}" does not end with "_test".`,
    );
  }
  return url;
}
