// Prisma 7 configuration.
//
// Development configuration is standardized on a single `.env` file at the project root
// (copy `.env.example`). Prisma 7 no longer loads `.env` itself, so it is loaded here.
import "dotenv/config";
import { defineConfig } from "prisma/config";

// CLI commands that connect to a database. Others (generate, validate, format, version)
// must keep working without DATABASE_URL — e.g. `prisma generate` in CI or a Docker build.
const DATABASE_COMMANDS = new Set(["migrate", "db", "studio"]);

const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";

if (databaseUrl === "" && command !== undefined && DATABASE_COMMANDS.has(command)) {
  throw new Error(
    `DATABASE_URL is not set, but \`prisma ${command}\` needs a database connection.\n` +
      "Copy .env.example to .env and set DATABASE_URL " +
      "(e.g. postgresql://USER:PASSWORD@localhost:5432/flexibx?schema=public).",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: databaseUrl,
  },
});
