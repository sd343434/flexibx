// Turns a PostgreSQL connection URL into libpq environment variables, so the ops scripts
// never pass the URL (or its password) as a command-line argument: arguments are visible
// to every user of the machine (`ps`, /proc/<pid>/cmdline); the environment and a 0600
// file are not. Used by lib/pgenv.sh only.
//
//   FLEXIBX_PG_URL=postgresql://… node pg-url.mjs <private directory>
//
// Reads the URL from the environment (never argv). Writes into the directory:
//   env     NUL-separated NAME=value pairs (only the PG* names below)
//   pgpass  the password, in .pgpass format, mode 0600 (only when the URL has one)
// Fails closed (exit 2, a reason code on stderr, never the URL or any part of it) for
// anything it cannot map exactly: other schemes, several hosts, unknown or repeated
// parameters, a schema other than `public`, a transaction pooler (`pgbouncer`).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

/** URL query parameters passed on to libpq, and their environment variable. */
const LIBPQ_PARAMETERS = {
  sslmode: "PGSSLMODE",
  sslrootcert: "PGSSLROOTCERT",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
  sslcrl: "PGSSLCRL",
  connect_timeout: "PGCONNECT_TIMEOUT",
  application_name: "PGAPPNAME",
  options: "PGOPTIONS",
  target_session_attrs: "PGTARGETSESSIONATTRS",
  host: "PGHOST",
};
/** Prisma client pool settings: meaningless for pg_dump/psql, safely ignored. */
const PRISMA_POOL_PARAMETERS = new Set(["connection_limit", "pool_timeout", "socket_timeout"]);

function refuse(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** `.pgpass` field: `\` and `:` are escaped. */
const pgpassField = (value) => value.replace(/[\\:]/g, (char) => `\\${char}`);

function decode(value, what) {
  try {
    return decodeURIComponent(value);
  } catch {
    return refuse(`invalid_${what}_encoding`);
  }
}

const dir = process.argv[2];
const raw = process.env.FLEXIBX_PG_URL ?? "";
if (dir === undefined || dir === "") refuse("usage");
if (raw === "") refuse("missing_url");

let url;
try {
  url = new URL(raw);
} catch {
  refuse("unparseable_url");
}
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") refuse("unsupported_scheme");
if (url.hash !== "") refuse("unexpected_fragment");

const env = {};
const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
if (host.includes(",") || url.host.includes(",")) refuse("multiple_hosts");
if (host !== "") env.PGHOST = decode(host, "host");
if (url.port !== "") env.PGPORT = url.port;
if (url.username !== "") env.PGUSER = decode(url.username, "user");

const path = url.pathname.replace(/^\//, "");
if (path.includes("/")) refuse("invalid_database_name");
if (path !== "") env.PGDATABASE = decode(path, "database");

const seen = new Set();
for (const [name, value] of url.searchParams) {
  if (seen.has(name)) refuse("repeated_parameter");
  seen.add(name);
  if (name === "schema") {
    if (value !== "public") refuse("unsupported_schema");
  } else if (PRISMA_POOL_PARAMETERS.has(name)) {
    // ignored
  } else if (Object.hasOwn(LIBPQ_PARAMETERS, name)) {
    if (name === "host" && env.PGHOST !== undefined) refuse("multiple_hosts");
    if (name === "host" && value.includes(",")) refuse("multiple_hosts");
    env[LIBPQ_PARAMETERS[name]] = value;
  } else {
    // Includes `pgbouncer` (a transaction pooler cannot run pg_dump) and anything new.
    refuse("unsupported_parameter");
  }
}
for (const value of Object.values(env)) {
  if (value.includes("\0") || value.includes("\n")) refuse("invalid_character");
}

if (url.password !== "") {
  const password = decode(url.password, "password");
  if (password.includes("\n") || password.includes("\0")) refuse("invalid_character");
  const file = join(dir, "pgpass");
  // Wildcards: the file lives for one run and serves only this connection.
  writeFileSync(file, `*:*:*:*:${pgpassField(password)}\n`, { mode: 0o600, flag: "wx" });
  env.PGPASSFILE = file;
}

writeFileSync(
  join(dir, "env"),
  Object.entries(env)
    .map(([name, value]) => `${name}=${value}\0`)
    .join(""),
  { mode: 0o600, flag: "wx" },
);
