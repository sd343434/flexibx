// What the media runner (Pass 42) refuses to start with: any environment variable whose
// name looks like a credential or a connection string. The runner needs none — FFmpeg
// reads local files only — so finding one means its container was given the worker's
// environment by mistake. Names are reported, never values.

const SENSITIVE = [
  /^DATABASE_URL$/,
  /DATABASE/,
  /SECRET/,
  /KEY/,
  /TOKEN/,
  /PASSWORD/,
  /PASSWD/,
  /CREDENTIAL/,
  /^AWS_/,
  /^S3_/,
  /^OPENAI_/,
  /^RESEND_/,
  /^SMTP_/,
  /^PG/,
  /_URL$/,
  /_DSN$/,
];

export function sensitiveEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => (env[name] ?? "") !== "")
    .filter((name) => SENSITIVE.some((pattern) => pattern.test(name.toUpperCase())))
    .sort();
}

/**
 * Pass 42: why this process may not run media work, or null. In production FFmpeg runs
 * only in the isolated media runner: no runner socket configured is a refusal, never a
 * silent fallback to FFmpeg next to the worker's credentials.
 */
export function mediaIsolationProblem(env: {
  readonly NODE_ENV: string;
  readonly CREATOR_MEDIA_RUNNER_SOCKET?: string | undefined;
}): string | null {
  if (env.NODE_ENV === "production" && (env.CREATOR_MEDIA_RUNNER_SOCKET ?? "") === "") {
    return "CREATOR_MEDIA_RUNNER_SOCKET is not set: in production FFmpeg runs only in the isolated media runner (docs/runbooks/MEDIA_ISOLATION.md)";
  }
  return null;
}
