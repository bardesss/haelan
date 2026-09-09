#!/usr/bin/env bash
# Boots an image twice against one volume and checks it answers both times.
#
# Twice, because the two runs exercise different code: the first creates the database and the
# second opens one that already exists and migrates it. A check that starts the container once
# passes for an image that can only ever be installed, never upgraded.
set -euo pipefail

IMAGE="${1:?usage: check-image-boots.sh <image-tag> [platform]}"
PLATFORM="${2:-}"
VOLUME="haelan-boot-check-$$"
CONTAINER="haelan-boot-check-$$"
PLATFORM_ARG=()
[ -n "$PLATFORM" ] && PLATFORM_ARG=(--platform "$PLATFORM")

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

boot() {
  local attempt="$1"
  docker run -d --name "$CONTAINER" "${PLATFORM_ARG[@]}" \
    -v "$VOLUME:/data" -p 4235:4235 "$IMAGE" >/dev/null

  # Polled rather than slept: an arm64 container under emulation is slow enough that any fixed
  # wait is either a flake or a minute nobody needed.
  local body=""
  for _ in $(seq 1 60); do
    if body=$(curl -fsS http://localhost:4235/api/setup/state 2>/dev/null); then break; fi
    sleep 2
  done

  if [ -z "$body" ]; then
    echo "boot $attempt: no answer from /api/setup/state" >&2
    docker logs "$CONTAINER" >&2 || true
    return 1
  fi
  echo "boot $attempt: $body"

  # The first wizard step, which is what an instance with no accounts must report. Asserting the
  # value and not merely a 200 is what makes this prove the database was read.
  case "$body" in
    *'"account"'*) ;;
    *) echo "boot $attempt: expected the account step, got: $body" >&2; return 1 ;;
  esac

  docker exec "$CONTAINER" test -f /data/haelan.sqlite \
    || { echo "boot $attempt: /data/haelan.sqlite was not created" >&2; return 1; }

  # Non-root, asserted rather than assumed: a container that quietly runs as root still passes
  # every other check here.
  local who
  who=$(docker exec "$CONTAINER" id -un)
  [ "$who" = "node" ] || { echo "boot $attempt: running as $who, expected node" >&2; return 1; }

  docker rm -f "$CONTAINER" >/dev/null
}

boot 1
boot 2
echo "image boots from an empty volume and again over the database it created"
