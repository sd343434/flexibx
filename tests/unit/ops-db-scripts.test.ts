// scripts/ops/db-{backup,restore,verify}.sh with fake pg_dump / psql / pg_restore / pnpm:
// the connection URL and its password never reach a command line or the output, the
// temporary password file is private and removed, failures exit non-zero, unparseable
// URLs are refused before any connection, and connection options are preserved.
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const script = (name: string) => join(root, "scripts/ops", name);
const LAST_MIGRATION = readdirSync(join(root, "prisma/migrations"))
  .filter((name) => /^\d{14}_/.test(name))
  .sort()
  .at(-1);
const PASSWORD = "s3cr:et\\p@ss/word";
const URL_WITH_PASSWORD = `postgresql://backup_user:${encodeURIComponent(PASSWORD)}@db.internal:6543/flexibx_prod?sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem&connect_timeout=7&application_name=ops&schema=public&connection_limit=5`;

// One fake for every client: records argv, the PG* environment and the password file
// (path, mode, content) as JSON lines, then behaves like the real tool enough for the
// scripts (FAKE_FAIL="psql …" makes the listed tools fail like a refused connection).
const FAKE = `#!/usr/bin/env bash
tool="$(basename "$0")"
pass_mode=""; pass_content=""
if [[ -n "\${PGPASSFILE:-}" && -f "$PGPASSFILE" ]]; then
  pass_mode="$(stat -c %a "$PGPASSFILE")"; pass_content="$(cat "$PGPASSFILE")"
fi
node -e 'const [tool, mode, content, ...argv] = process.argv.slice(1);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PG") || k.endsWith("DATABASE_URL")));
  require("fs").appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool, argv, env, passMode: mode, passContent: content }) + "\\n");' \\
  "$tool" "$pass_mode" "$pass_content" "$@"
if [[ " \${FAKE_FAIL:-} " == *" $tool "* ]]; then echo "connection refused" >&2; exit 2; fi
case "$tool" in
  pg_dump)
    for arg in "$@"; do [[ "$arg" == --file=* ]] && printf 'PGDMP fake' > "\${arg#--file=}"; done ;;
  psql)
    args="$*"
    if [[ "$args" == *current_database* ]]; then echo "\${PGDATABASE:-}"
    elif [[ "$args" == *information_schema.tables* ]]; then echo "\${FAKE_TABLES:-0}"
    elif [[ "$args" == *row-counts.sql* ]]; then printf 'users\\t3\\nworkspaces\\t1\\n'
    elif [[ "$args" == *integrity.sql* ]]; then printf 'credit_balance_vs_ledger\\t0\\norphans\\t0\\n'
    elif [[ "$args" == *restore-checks.sql* ]]; then
      printf 'indexes_invalid\\t0\\nvideo_usage_vs_jobs\\t%s\\n' "\${FAKE_VIDEO_USAGE:-0}"
    elif [[ "$args" == *schema-objects.sql* ]]; then
      # The migrated schema, minus or plus one object when asked.
      grep -v '^#' scripts/ops/sql/expected-schema-objects.tsv | \\
        { if [[ "\${FAKE_SCHEMA:-}" == "missing" ]]; then sed 1d; else cat; fi; }
      [[ "\${FAKE_SCHEMA:-}" == "extra" ]] && printf 'index\\tusers\\tusers_by_hand\\n'
    elif [[ "$args" == *_prisma_migrations* ]]; then
      # What Prisma records: name + SHA-256 of each applied migration.sql.
      for file in prisma/migrations/*/migration.sql; do
        name="$(basename "$(dirname "$file")")"; sum="$(sha256sum "$file" | cut -d' ' -f1)"
        [[ "\${FAKE_MIGRATIONS:-}" == "pending" && "$name" == "$FAKE_LAST" ]] && continue
        [[ "\${FAKE_MIGRATIONS:-}" == "modified" && "$name" == "$FAKE_LAST" ]] && sum="0000"
        # Applied from a CRLF checkout: Prisma recorded the checksum of the CRLF bytes.
        [[ "\${FAKE_MIGRATIONS:-}" == "crlf" && "$name" == "$FAKE_LAST" ]] && \
          sum="$(sed ':a;N;$!ba;s/\\n/\\r\\n/g' "$file" | sha256sum | cut -d' ' -f1)"
        # An edit that also changes line endings is still an edit.
        [[ "\${FAKE_MIGRATIONS:-}" == "crlf-modified" && "$name" == "$FAKE_LAST" ]] && \
          sum="$( { cat "$file"; echo "-- edited"; } | sed ':a;N;$!ba;s/\\n/\\r\\n/g' | sha256sum | cut -d' ' -f1)"
        printf '%s\\t%s\\n' "$name" "$sum"
      done
      [[ "\${FAKE_MIGRATIONS:-}" == "unknown" ]] && printf '29990101000000_hotfix\\tabcd\\n'
    fi ;;
  pnpm) [[ -n "\${DATABASE_URL:-}" ]] || exit 1 ;;
esac
exit 0
`;

let work: string;
let bin: string;
let log: string;
let out: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ops-scripts-"));
  bin = join(work, "bin");
  out = join(work, "backups");
  log = join(work, "calls.jsonl");
  mkdirSync(bin);
  for (const tool of ["pg_dump", "psql", "pg_restore", "pnpm"]) {
    writeFileSync(join(bin, tool), FAKE);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(log, "");
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Call {
  readonly tool: string;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly passMode: string;
  readonly passContent: string;
}
const calls = (): Call[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Call);

async function run(name: string, args: readonly string[], env: Record<string, string>) {
  try {
    const result = await promisify(execFile)("bash", [script(name), ...args], {
      cwd: root,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_LOG: log,
        TMPDIR: work,
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** A row-count manifest with its checksum, as db-backup.sh writes them. */
async function manifest(): Promise<string> {
  const { createHash } = await import("node:crypto");
  const counts = join(work, `x-${Math.random().toString(16).slice(2)}.counts.tsv`);
  const body = "users\t3\nworkspaces\t1\n";
  writeFileSync(counts, body);
  writeFileSync(`${counts}.sha256`, `${createHash("sha256").update(body).digest("hex")}\n`);
  return counts;
}

/** Temporary password-file directories left behind under TMPDIR. */
const leftovers = () => readdirSync(work).filter((entry) => entry.startsWith("tmp.")); // mktemp -d

function expectNoSecretAnywhere(result: { stdout: string; stderr: string }) {
  const text = result.stdout + result.stderr + JSON.stringify(calls().map((c) => c.argv));
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(encodeURIComponent(PASSWORD));
  expect(text).not.toMatch(/postgres(ql)?:\/\//);
  for (const call of calls()) {
    // The source variable is not inherited (Prisma alone gets DATABASE_URL, in its env).
    expect(Object.keys(call.env).filter((k) => k.endsWith("_DATABASE_URL"))).toEqual([]);
  }
}

describe("ops database scripts keep the URL off the command line", () => {
  it("backup: libpq environment + private password file, options preserved, file removed", async () => {
    const result = await run("db-backup.sh", [out], { BACKUP_DATABASE_URL: URL_WITH_PASSWORD });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "OK", tables: 2 });
    expectNoSecretAnywhere(result);

    const [dump, counts] = calls();
    expect(dump?.tool).toBe("pg_dump");
    expect(dump?.argv.some((arg) => arg.startsWith("--dbname"))).toBe(false);
    expect(dump?.env).toMatchObject({
      PGHOST: "db.internal",
      PGPORT: "6543",
      PGUSER: "backup_user",
      PGDATABASE: "flexibx_prod",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/etc/ca.pem",
      PGCONNECT_TIMEOUT: "7",
      PGAPPNAME: "ops",
    });
    expect(dump?.env.PGPASSWORD).toBeUndefined();
    expect(dump?.passMode).toBe("600");
    // .pgpass escaping of `:` and `\`.
    expect(dump?.passContent).toBe("*:*:*:*:s3cr\\:et\\\\p@ss/word");
    expect(counts?.tool).toBe("psql");
    expect(counts?.env.PGPASSFILE).toBe(dump?.env.PGPASSFILE);
    // The manifest gets its own checksum (db-verify.sh refuses a manifest without one).
    const written = readdirSync(out);
    expect(written.filter((name) => name.endsWith(".counts.tsv.sha256"))).toHaveLength(1);
    // Removed when the script ends.
    expect(existsSync(dump?.env.PGPASSFILE ?? "")).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("without a password in the URL: no password file, PGPASSWORD / ~/.pgpass still work", async () => {
    const result = await run("db-backup.sh", [out], {
      BACKUP_DATABASE_URL: "postgresql://ops@localhost/flexibx",
      PGPASSWORD: "from-env",
    });
    expect(result.code).toBe(0);
    const [dump] = calls();
    expect(dump?.env.PGPASSFILE).toBeUndefined();
    expect(dump?.env.PGPASSWORD).toBe("from-env");
    expect(dump?.env).toMatchObject({ PGHOST: "localhost", PGUSER: "ops", PGDATABASE: "flexibx" });
  });

  it("a password in the URL wins over PGPASSWORD (as with --dbname=<url>)", async () => {
    const result = await run("db-backup.sh", [out], {
      BACKUP_DATABASE_URL: URL_WITH_PASSWORD,
      PGPASSWORD: "stale",
    });
    expect(result.code).toBe(0);
    expect(calls()[0]?.env.PGPASSWORD).toBeUndefined();
  });

  it("connection failure: non-zero exit, no partial dump, password file removed", async () => {
    const result = await run("db-backup.sh", [out], {
      BACKUP_DATABASE_URL: URL_WITH_PASSWORD,
      FAKE_FAIL: "pg_dump psql pg_restore",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('"status":"FAILED"');
    expectNoSecretAnywhere(result);
    expect(readdirSync(out)).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ["not a url", "unparseable_url"],
    ["mysql://u:pw@h/db", "unsupported_scheme"],
    ["postgresql://u:pw@h1,h2/db", "multiple_hosts"],
    ["postgresql://u:pw@h/db?pgbouncer=true", "unsupported_parameter"],
    ["postgresql://u:pw@h/db?sslmode=require&sslmode=disable", "repeated_parameter"],
    ["postgresql://u:pw@h/db?schema=tenant", "unsupported_schema"],
    ["postgresql://u:pw@h/db/extra", "invalid_database_name"],
    ["postgresql://u:%E0%A4%A@h/db", "invalid_password_encoding"],
  ])("refuses %s before any connection (%s)", async (url, reason) => {
    const result = await run("db-backup.sh", [out], { BACKUP_DATABASE_URL: url });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`"status":"REFUSED"`);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).not.toContain(url);
    expect(result.stderr).not.toContain("pw");
    expect(calls()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("restore: checks, then pg_restore into the confirmed database name only", async () => {
    const dump = join(work, "flexibx-x.dump");
    writeFileSync(dump, "PGDMP fake");
    const { createHash } = await import("node:crypto");
    writeFileSync(`${dump}.sha256`, `${createHash("sha256").update("PGDMP fake").digest("hex")}\n`);
    const url = URL_WITH_PASSWORD.replace("flexibx_prod", "flexibx_restore");

    const wrong = await run("db-restore.sh", [dump, "--confirm-target", "flexibx_prod"], {
      RESTORE_DATABASE_URL: url,
    });
    expect(wrong.code).toBe(2);
    expect(calls().some((call) => call.tool === "pg_restore")).toBe(false);

    writeFileSync(log, "");
    const result = await run("db-restore.sh", [dump, "--confirm-target", "flexibx_restore"], {
      RESTORE_DATABASE_URL: url,
    });
    expect(result.code).toBe(0);
    expectNoSecretAnywhere(result);
    const restore = calls().find((call) => call.tool === "pg_restore");
    expect(restore?.argv).toContain("--dbname=flexibx_restore");
    expect(restore?.argv).toContain("--single-transaction");
    expect(restore?.env).toMatchObject({ PGHOST: "db.internal", PGSSLMODE: "verify-full" });
    expect(restore?.passMode).toBe("600");
    expect(leftovers()).toEqual([]);

    writeFileSync(log, "");
    const failing = await run("db-restore.sh", [dump, "--confirm-target", "flexibx_restore"], {
      RESTORE_DATABASE_URL: url,
      FAKE_FAIL: "pg_dump psql pg_restore",
    });
    expect(failing.code).not.toBe(0);
    expect(calls().some((call) => call.tool === "pg_restore")).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("verify: everything through psql with libpq environment (no Prisma process)", async () => {
    const counts = await manifest();
    const result = await run("db-verify.sh", [counts], { VERIFY_DATABASE_URL: URL_WITH_PASSWORD });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('{"status":"VERIFIED"}');
    expect(result.stdout + result.stderr).not.toContain(PASSWORD);
    const tools = calls().map((call) => call.tool);
    // Prisma's schema engine would get the URL on its command line: not used.
    expect(tools).toEqual(["psql", "psql", "psql", "psql", "psql"]);
    expect(result.stdout).toMatch(/prisma_migrations\tup to date \(\d+ applied\)/);
    expect(result.stdout).toMatch(/row_counts\tmatch \(2 tables\)/);
    expect(result.stdout).toMatch(/schema_objects\tmatch \(\d+ indexes and constraints\)/);
    expect(result.stdout).toContain("video_usage_vs_jobs\t0");
    for (const call of calls()) {
      expect(JSON.stringify(call.argv)).not.toContain(encodeURIComponent(PASSWORD));
      expect(JSON.stringify(call.argv)).not.toMatch(/postgres(ql)?:\/\//);
    }
    expect(leftovers()).toEqual([]);
  });

  it("verify: a connection failure is a failure, never VERIFIED", async () => {
    const result = await run("db-verify.sh", ["--no-row-counts"], {
      VERIFY_DATABASE_URL: URL_WITH_PASSWORD,
      FAKE_FAIL: "psql",
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("VERIFIED");
    expect(result.stdout).toContain('"status":"FAILED"');
    expect(leftovers()).toEqual([]);
  });

  it("verify: a line-ending-only difference (CRLF checkout) is tolerated", async () => {
    const result = await run("db-verify.sh", ["--no-row-counts"], {
      VERIFY_DATABASE_URL: URL_WITH_PASSWORD,
      FAKE_MIGRATIONS: "crlf",
      FAKE_LAST: LAST_MIGRATION ?? "",
    });
    expect(result.stdout).toMatch(/prisma_migrations\tup to date/);
    expect(result.code).toBe(0);
  });

  it.each(["pending", "modified", "unknown", "crlf-modified"])(
    "verify: a %s migration fails the verification",
    async (state) => {
      const result = await run("db-verify.sh", ["--no-row-counts"], {
        VERIFY_DATABASE_URL: URL_WITH_PASSWORD,
        FAKE_MIGRATIONS: state,
        FAKE_LAST: LAST_MIGRATION ?? "",
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("prisma_migrations\tNOT up to date");
      expect(result.stdout).toContain('{"status":"FAILED"}');
      if (state === "pending") expect(result.stdout).toContain(`pending: ${LAST_MIGRATION}`);
      if (state === "unknown") expect(result.stdout).toContain("unknown: 29990101000000_hotfix");
      if (state.endsWith("modified")) {
        expect(result.stdout).toContain(`modified: ${LAST_MIGRATION ?? ""}`);
      }
    },
  );

  it("verify: the row-count manifest is required, and must match its checksum", async () => {
    const refused = await run("db-verify.sh", [], { VERIFY_DATABASE_URL: URL_WITH_PASSWORD });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--no-row-counts");
    expect(calls()).toEqual([]); // refused before any connection

    const counts = await manifest();
    rmSync(`${counts}.sha256`);
    const unchecked = await run("db-verify.sh", [counts], {
      VERIFY_DATABASE_URL: URL_WITH_PASSWORD,
    });
    expect(unchecked.code).toBe(1);
    expect(unchecked.stdout).toContain("row_counts_manifest\tMISSING");

    const edited = await manifest();
    writeFileSync(edited, "users\t3\nworkspaces\t9\n"); // edited after the backup
    const tampered = await run("db-verify.sh", [edited], {
      VERIFY_DATABASE_URL: URL_WITH_PASSWORD,
    });
    expect(tampered.code).toBe(1);
    expect(tampered.stdout).toContain("row_counts_manifest\tCHECKSUM MISMATCH");
    expect(tampered.stdout).not.toContain("VERIFIED");
  });

  it.each([
    ["missing", "1 missing, 0 unexpected", "  missing: "],
    ["extra", "0 missing, 1 unexpected", "  unexpected: index\tusers\tusers_by_hand"],
  ])("verify: a %s index or constraint fails the verification", async (state, summary, line) => {
    const result = await run("db-verify.sh", ["--no-row-counts"], {
      VERIFY_DATABASE_URL: URL_WITH_PASSWORD,
      FAKE_SCHEMA: state,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`schema_objects\tMISMATCH (${summary})`);
    expect(result.stdout).toContain(line);
    expect(result.stdout).toContain('{"status":"FAILED"}');
  });

  it("verify: a restore check that is not 0 fails the verification", async () => {
    const result = await run("db-verify.sh", ["--no-row-counts"], {
      VERIFY_DATABASE_URL: URL_WITH_PASSWORD,
      FAKE_VIDEO_USAGE: "2",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("video_usage_vs_jobs\t2");
    expect(result.stdout).toContain('{"status":"FAILED"}');
  });

  it("schema objects: prints the expected-file format, URL off the command line", async () => {
    const result = await run("db-schema-objects.sh", [], {
      SCHEMA_DATABASE_URL: URL_WITH_PASSWORD,
    });
    expect(result.code).toBe(0);
    expectNoSecretAnywhere(result);
    expect(result.stdout).toBe(
      readFileSync(join(root, "scripts/ops/sql/expected-schema-objects.tsv"), "utf8"),
    );
    expect(leftovers()).toEqual([]);
  });

  it("no ops script passes a connection URL as an argument", () => {
    for (const name of ["db-backup.sh", "db-restore.sh", "db-verify.sh", "db-schema-objects.sh"]) {
      const source = readFileSync(script(name), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      expect(source, name).not.toMatch(/--dbname="\$url"|-d "\$url"|\$\{?url\}?"? *$/m);
      expect(source, name).toContain("pg_use_url");
      expect(source, name).not.toMatch(/prisma migrate|pnpm exec|DATABASE_URL="/);
    }
  });
});
