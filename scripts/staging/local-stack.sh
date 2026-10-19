#!/usr/bin/env bash
# Staging-like acceptance on THIS machine (Pass 12): a disposable S3-compatible bucket
# (SeaweedFS in Docker, private, with the CORS and lifecycle rules of
# docs/runbooks/STAGING_CREATOR_STUDIO.md § 2), then the Creator Studio acceptance suite
# against it, the real test database and the real FFmpeg (pnpm test:acceptance).
#
#   TEST_DATABASE_URL=postgresql://…/flexibx_test scripts/staging/local-stack.sh
#
# Needs: Docker, FFmpeg 6+, and TEST_DATABASE_URL (a database whose name ends in _test;
# the suite empties it). Creates nothing paid and reaches no external service: the bucket
# lives in a throwaway container bound to 127.0.0.1 with a random key, and is removed at
# the end (also on failure). Prints no key. Exit code: the suite's.
#
# STAGING_S3_IMAGE overrides the image (default chrislusf/seaweedfs:latest; pin a digest
# for reproducible runs). STAGING_S3_PORT overrides the port (default 8333).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a disposable *_test database}"
image="${STAGING_S3_IMAGE:-chrislusf/seaweedfs:latest}"
port="${STAGING_S3_PORT:-8333}"
name="flexibx-staging-s3-$$"
bucket="flexibx-acceptance"

work="$(mktemp -d)"
chmod 700 "$work"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

access="acc$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
secret="$(od -An -N20 -tx1 /dev/urandom | tr -d ' \n')"
# The only identity: full rights on the acceptance bucket, nothing else; no anonymous access.
cat >"$work/s3.json" <<EOF
{"identities":[{"name":"acceptance","credentials":[{"accessKey":"$access","secretKey":"$secret"}],
"actions":["Read:$bucket","Write:$bucket","List:$bucket","Tagging:$bucket","Admin:$bucket"]}]}
EOF
chmod 644 "$work/s3.json"

echo "== starting a disposable S3-compatible bucket ($image) on 127.0.0.1:$port"
docker run -d --name "$name" -p "127.0.0.1:$port:8333" \
  -v "$work/s3.json:/etc/seaweedfs/s3.json:ro" "$image" \
  server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$name" sh -c "echo 's3.bucket.create -name $bucket' | weed shell -master=localhost:9333" \
    2>/dev/null | grep -q "created bucket\|already exists"; then
    break
  fi
  sleep 1
done
anonymous=000
for _ in $(seq 1 60); do
  anonymous="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/$bucket" || true)"
  [[ "$anonymous" != 000 ]] && break
  sleep 1
done
if [[ "$anonymous" != 403 ]]; then
  echo "the bucket answered an anonymous listing with HTTP $anonymous (expected 403)" >&2
  exit 1
fi

export ACCEPTANCE_S3_ENDPOINT="http://127.0.0.1:$port"
export ACCEPTANCE_S3_BUCKET="$bucket"
export ACCEPTANCE_S3_ACCESS_KEY_ID="$access"
export ACCEPTANCE_S3_SECRET_ACCESS_KEY="$secret"

echo "== bucket rules (CORS for the app's origin, abort of incomplete uploads)"
(cd "$root" && node -e '
  const s3 = require("@aws-sdk/client-s3");
  const env = process.env;
  const client = new s3.S3Client({
    region: "us-east-1", forcePathStyle: true, endpoint: env.ACCEPTANCE_S3_ENDPOINT,
    credentials: { accessKeyId: env.ACCEPTANCE_S3_ACCESS_KEY_ID, secretAccessKey: env.ACCEPTANCE_S3_SECRET_ACCESS_KEY },
  });
  const Bucket = env.ACCEPTANCE_S3_BUCKET;
  (async () => {
    await client.send(new s3.PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [
      { AllowedOrigins: ["http://127.0.0.1:3000"], AllowedMethods: ["PUT"], AllowedHeaders: ["content-type"], MaxAgeSeconds: 600 },
    ] } }));
    await client.send(new s3.PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: [
      { ID: "abort-incomplete-multipart", Status: "Enabled", Filter: { Prefix: "workspaces/" },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 } },
    ] } }));
    console.log("rules set");
  })().catch((error) => { console.error("could not set bucket rules:", error.name); process.exit(1); });
')

echo "== acceptance suite"
cd "$root"
pnpm test:acceptance
