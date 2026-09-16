#!/usr/bin/env bash
# Runs a command, and retries it exactly once if it died the way a crashed test worker dies.
#
# This exists for one failure with a measured shape. A vitest pool worker takes SIGSEGV inside
# V8's WebAssembly engine - reached through Node's type stripper, not through better-sqlite3 -
# and the run exits non-zero with every single test passed. It happened to v1.14.1's publish job
# (302 files green, one signal, no evidence) and again on master on 2026-09-15 (3816 passed, 12
# skipped, one SIGSEGV, exit 1). Roughly one run in a thousand.
#
# **It retries a crash and never an assertion failure**, which is the whole point: a suite that
# genuinely fails must still fail here, because this step exists to stop a release going out on
# a commit whose tests do not pass. The decision is made on the output, not on the exit code:
# a crash says so in words vitest only prints when a worker dies.
#
# A single retry, not a loop. If the crash is reproducible it is not the flake this is for, and
# a release job that spends twenty minutes failing the same way four times is worse than one
# that fails once and says what happened.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: retry-if-worker-crashed.sh <command> [args...]" >&2
  exit 2
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# tee rather than a plain redirect: the output has to reach the job log as it happens, or a suite
# that hangs looks identical to one that is merely slow.
"$@" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"

if [ "$status" -eq 0 ]; then
  exit 0
fi

# The phrases vitest prints when a worker dies rather than when a test fails. Both are matched
# because the two pools word it differently and the repo has used both.
if grep -qE "Worker exited unexpectedly|emitted error|SIGSEGV|SIGBUS|SIGILL" "$log"; then
  echo "::warning::a test worker crashed rather than failing an assertion; retrying once"
  echo "::notice::if this retry passes, the first run's core dump is still on /mnt/cores"
  "$@"
  exit "$?"
fi

echo "::error::the suite failed on its own terms, not on a worker crash - not retrying"
exit "$status"
