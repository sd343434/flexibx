// Builds the node_modules of a job image (worker, ops) with only what its commands load
// (Pass 14). Used by the Dockerfile's `*-deps` stages; never at run time.
//
//   node scripts/docker/job-deps.mjs <out-dir> worker|ops   (in the build stage, from /app)
//   node scripts/docker/job-deps.mjs --verify                (in the final image, from /app)
//   node scripts/docker/job-deps.mjs --list worker|ops       (prints what would be kept, as JSON)
//
// 1. esbuild (the one tsx itself runs on) follows every static and literal dynamic import
//    from the entrypoints — through the app's TypeScript (tsconfig paths included) and on
//    into node_modules — and reports every file it would load. Nothing is emitted: only the
//    import graph is read, so the result follows the code on every build. Each package a
//    loaded file belongs to is kept whole (all its files, not just the traced ones).
// 2. From those packages, their regular and optional dependencies are added (pnpm's links,
//    so versions are exactly the lockfile's). Peer dependencies are NOT followed: a peer is
//    kept only if the trace shows it is loaded (`next-intl` declares `next` as a peer, but
//    the part the mail templates use never loads it). The `--keep` packages are CLIs that
//    load their code dynamically (tsx, the Prisma CLI): they keep their whole closure,
//    required peers included. Hoisted links and `.bin` shims are kept only when they point
//    inside the result.
// 3. `node_modules/.job-deps.json` records the packages the job code imports directly plus the kept CLIs;
//    `--verify` resolves each of them from the image's /app, so an image missing one fails
//    its own build. The commands themselves are exercised by the image checks.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

/**
 * What each job image runs. An entrypoint missing here means a command whose packages may
 * be missing from the image: add it when a job image gains a command.
 */
const PROFILES = {
  // CMD and the commands documented for the worker image (STAGING_CREATOR_STUDIO.md § 3).
  worker: {
    entrypoints: [
      "scripts/creator/worker.ts",
      "scripts/creator/preflight.ts",
      "scripts/creator/retention-report.ts",
      "scripts/staging/check.ts",
      "scripts/video-retention/register.mjs",
    ],
    keep: ["tsx"],
  },
  // Migrations (Prisma CLI + prisma.config.ts), the operator CLIs, the scheduled jobs and
  // the single-host scheduler; the db-*.sh scripts need only psql/pg_dump.
  ops: {
    entrypoints: [
      "prisma.config.ts",
      "scripts/admin/grant.ts",
      "scripts/admin/mfa-reset.ts",
      "scripts/automation/tick.ts",
      "scripts/video-retention/run.ts",
      "scripts/creator/retention-report.ts",
      "scripts/ops/scheduler.ts",
      "scripts/video-retention/register.mjs",
    ],
    keep: ["tsx", "prisma"],
  },
};

const ROOT = process.cwd();
const MODULES = join(ROOT, "node_modules");
const STORE = join(MODULES, ".pnpm");

function fail(message) {
  process.stderr.write(`job-deps: ${message}\n`);
  process.exit(1);
}

/** "@scope/name/sub/path" → "@scope/name"; "name/sub" → "name". */
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

async function trace(entrypoints) {
  const esbuild = createRequire(realpathSync(join(MODULES, "tsx", "package.json")))("esbuild");
  const options = {
    absWorkingDir: ROOT,
    entryPoints: entrypoints,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    outdir: join(ROOT, ".job-deps-unused"),
    logLevel: "error",
    loader: { ".wasm": "empty", ".node": "empty" },
  };
  // Direct imports of the job code (for --verify) …
  const direct = await esbuild.build({ ...options, packages: "external" });
  const imported = new Set();
  for (const input of Object.values(direct.metafile.inputs)) {
    for (const entry of input.imports) {
      if (!entry.external || builtins.has(entry.path) || entry.path.startsWith(".")) continue;
      imported.add(packageName(entry.path));
    }
  }
  // … and every package file the whole graph loads (esbuild resolves to real paths).
  const full = await esbuild.build(options);
  const loaded = new Map(); // store dir → package name
  for (const file of Object.keys(full.metafile.inputs)) {
    const match = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
    if (match !== null) loaded.set(match[1], match[2]);
  }
  return { imported: [...imported].sort(), loaded };
}

/** The `.pnpm/<dir>` directory holding the package a symlink resolves to. */
function storeDir(path) {
  const real = realpathSync(path);
  const rel = relative(STORE, real);
  if (rel.startsWith("..")) return null; // a workspace or non-store package: not expected here
  return rel.split(sep)[0];
}

/** Every package link directly inside `<dir>/node_modules` (scoped ones included). */
function links(modulesDir) {
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir).flatMap((name) => {
    if (name.startsWith(".")) return [];
    if (name.startsWith("@")) {
      return readdirSync(join(modulesDir, name)).map((sub) => join(modulesDir, name, sub));
    }
    return [join(modulesDir, name)];
  });
}

/** Names of the dependencies to follow from one package (see the header). */
function followed(dir, name, withPeers) {
  const manifest = JSON.parse(
    readFileSync(join(STORE, dir, "node_modules", name, "package.json"), "utf8"),
  );
  const names = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
  if (withPeers) {
    const optional = manifest.peerDependenciesMeta ?? {};
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (optional[peer]?.optional !== true) names.push(peer);
    }
  }
  return names;
}

function closure(loaded, keep) {
  const dirs = new Map(); // store dir → package name
  const queue = [...loaded].map(([dir, name]) => ({ dir, name, withPeers: false }));
  for (const name of keep) {
    const link = join(MODULES, name);
    const dir = existsSync(link) ? storeDir(link) : null;
    if (dir === null) fail(`${name} (--keep) is not installed`);
    queue.push({ dir, name, withPeers: true });
  }
  const visited = new Set();
  while (queue.length > 0) {
    const { dir, name, withPeers } = queue.pop();
    const key = `${dir}\0${String(withPeers)}`;
    if (visited.has(key)) continue;
    visited.add(key);
    dirs.set(dir, name);
    for (const dependency of followed(dir, name, withPeers)) {
      const link = join(STORE, dir, "node_modules", dependency);
      if (!existsSync(link)) continue; // an optional dependency for another platform
      const next = storeDir(link);
      if (next !== null) queue.push({ dir: next, name: dependency, withPeers });
    }
  }
  return new Set(dirs.keys());
}

function sizeOf(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => {
    const child = join(path, name);
    const childStat = statSync(child, { throwIfNoEntry: false });
    if (childStat === undefined) return sum;
    // Do not follow links out of the copied tree (they point at other store dirs).
    return (
      sum +
      (childStat.isDirectory() && !isLink(child)
        ? sizeOf(child)
        : childStat.isDirectory()
          ? 0
          : childStat.size)
    );
  }, 0);
}

function isLink(path) {
  try {
    readlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Copies one symlink as it is (relative targets stay valid in the same layout). */
function copyLink(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(readlinkSync(from), to);
}

/** A `.bin` shim is kept when every store directory it names is in the closure. */
function shimInside(shim, dirs) {
  const text = readFileSync(shim, "utf8");
  const named = [...text.matchAll(/node_modules\/\.pnpm\/([^/\s"':]+)/g)].map((match) => match[1]);
  return named.length > 0 && named.every((dir) => dir === "node_modules" || dirs.has(dir));
}

/** Roots and store directories of one profile, without copying anything. */
async function plan(keep, entrypoints) {
  if (entrypoints.length === 0) fail("no entrypoints");
  const { imported, loaded } = await trace(entrypoints);
  const roots = [...new Set([...imported, ...keep])].sort();
  for (const name of roots) {
    if (!existsSync(join(MODULES, name)))
      fail(`${name} is imported by the job code but not installed`);
  }
  const dirs = closure(loaded, keep);
  for (const name of roots) {
    const dir = storeDir(join(MODULES, name));
    // A type-only or unused import: esbuild drops it, so the package is not loaded either.
    if (dir !== null && !dirs.has(dir)) dirs.add(dir);
  }
  return { imported, roots, dirs };
}

/** "react-dom@19.3.1_react@19.3.1" → "react-dom"; "@scope+name@1.0.0_x" → "@scope/name". */
function storePackage(dir) {
  const name = dir.startsWith("@")
    ? dir.slice(0, dir.indexOf("@", 1))
    : dir.slice(0, dir.indexOf("@"));
  return name.replace("+", "/");
}

async function build(outDir, keep, entrypoints) {
  const { imported, roots, dirs } = await plan(keep, entrypoints);
  const out = join(resolve(outDir), "node_modules");
  mkdirSync(join(out, ".pnpm"), { recursive: true });
  for (const dir of dirs) {
    cpSync(join(STORE, dir), join(out, ".pnpm", dir), { recursive: true, verbatimSymlinks: true });
  }
  for (const name of roots) copyLink(join(MODULES, name), join(out, name));
  // Hoisted links (pnpm's fallback for undeclared imports) that stay inside the closure.
  for (const link of links(join(STORE, "node_modules"))) {
    if (!existsSync(link)) continue;
    const dir = storeDir(link);
    if (dir !== null && dirs.has(dir))
      copyLink(
        link,
        join(out, ".pnpm", "node_modules", relative(join(STORE, "node_modules"), link)),
      );
  }
  const binDir = join(MODULES, ".bin");
  for (const name of existsSync(binDir) ? readdirSync(binDir) : []) {
    const shim = join(binDir, name);
    if (statSync(shim).isFile() && shimInside(shim, dirs)) {
      mkdirSync(join(out, ".bin"), { recursive: true });
      cpSync(shim, join(out, ".bin", name));
    }
  }
  for (const file of [".modules.yaml", join(".pnpm", "lock.yaml")]) {
    if (existsSync(join(MODULES, file))) cpSync(join(MODULES, file), join(out, file));
  }
  writeFileSync(
    join(out, ".job-deps.json"),
    `${JSON.stringify({ roots, imported, keep }, null, 2)}\n`,
  );
  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  process.stdout.write(
    `job-deps: ${String(roots.length)} root packages (${imported.join(", ")}; kept: ${keep.join(", ") || "none"}), ` +
      `${String(dirs.size)} of ${String(readdirSync(STORE).length - 1)} store packages, ${mb(sizeOf(join(out, ".pnpm")))} of ${mb(sizeOf(STORE))}\n`,
  );
}

function verify() {
  const { roots } = JSON.parse(readFileSync(join(MODULES, ".job-deps.json"), "utf8"));
  // Follows the root link into the store: a dangling link or a missing package fails.
  const missing = roots.filter((name) => !existsSync(join(MODULES, name, "package.json")));
  if (missing.length > 0) fail(`missing in this image: ${missing.join(", ")}`);
  process.stdout.write(`job-deps: all ${String(roots.length)} root packages present\n`);
}

const [first, profileName] = process.argv.slice(2);
if (first === "--verify") {
  verify();
} else if (first === "--list") {
  const profile = PROFILES[profileName] ?? fail(`unknown profile: ${String(profileName)}`);
  const { roots, dirs } = await plan(profile.keep, profile.entrypoints);
  const packages = [...new Set([...dirs].map(storePackage))].sort();
  process.stdout.write(`${JSON.stringify({ roots, packages })}\n`);
} else {
  const profile = PROFILES[profileName];
  if (first === undefined || profile === undefined) {
    fail(
      `usage: job-deps.mjs <out-dir> ${Object.keys(PROFILES).join("|")}  |  job-deps.mjs --verify`,
    );
  }
  await build(first, profile.keep, profile.entrypoints);
}
