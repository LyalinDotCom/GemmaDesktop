#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

MODEL="${MODEL:-gemma4:31b}"
GEMMA_PACKAGE="${GEMMA_PACKAGE:-gemma-cli@latest}"
DATASET="${DATASET:-terminal-bench@2.0}"
OLLAMA_URL="${OLLAMA_URL:-http://host.docker.internal:11434}"
MAX_TURNS="${MAX_TURNS:-200}"
MAX_TOKENS="${MAX_TOKENS:-4096}"
THINK="${THINK:-off}"
SHELL_IDLE_TIMEOUT_MS="${SHELL_IDLE_TIMEOUT_MS:-300000}"
N_ATTEMPTS="${N_ATTEMPTS:-1}"
N_CONCURRENT="${N_CONCURRENT:-1}"
TIMEOUT_MULTIPLIER="${TIMEOUT_MULTIPLIER:-5}"
JOBS_DIR="${JOBS_DIR:-/tmp/gemma-cli-tbench2-31b}"

safe_package="${GEMMA_PACKAGE//@/-}"
safe_package="${safe_package//[^A-Za-z0-9_.-]/-}"
safe_model="${MODEL//[:\/]/-}"
JOB_NAME="${JOB_NAME:-gemma-cli-${safe_package}-${safe_model}-tbench2-$(date +%Y%m%d-%H%M%S)}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for Harbor's default environment." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is installed but not reachable. Start Docker and rerun this script." >&2
  exit 1
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama is not on PATH. Install/start Ollama before running local models." >&2
  exit 1
fi

if ! ollama list | awk 'NR > 1 { print $1 }' | grep -Fxq "$MODEL"; then
  echo "Warning: Ollama model '$MODEL' was not found in 'ollama list'." >&2
  echo "Set MODEL=... or pull/create the model before expecting the run to work." >&2
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to prepare or verify the Gemma CLI package before starting Harbor." >&2
  exit 1
fi

package_label="$GEMMA_PACKAGE"
local_pack_dir=""
core_tarball=""
cli_tarball=""
if [[ "$GEMMA_PACKAGE" == "local" ]]; then
  local_pack_dir="${PACK_DIR:-/tmp/gemma-cli-tbench2-packs}"
  mkdir -p "$local_pack_dir"
  npm run build
  core_pack="$(npm pack --workspace gemma-cli-core --pack-destination "$local_pack_dir" --silent | tail -n 1)"
  cli_pack="$(npm pack --workspace gemma-cli --pack-destination "$local_pack_dir" --silent | tail -n 1)"
  core_tarball="$local_pack_dir/$core_pack"
  cli_tarball="$local_pack_dir/$cli_pack"
  package_label="local tarballs $(node -p "require('./packages/cli/package.json').version")"
else
  if ! published_version="$(npm view "$GEMMA_PACKAGE" version 2>/dev/null)"; then
    echo "Could not resolve '$GEMMA_PACKAGE' from npm." >&2
    echo "Publish Gemma CLI first, set GEMMA_PACKAGE=gemma-cli@<published-version>, or set GEMMA_PACKAGE=local to pack this checkout." >&2
    exit 1
  fi
  package_label="$GEMMA_PACKAGE (resolved $published_version)"
fi

args=(
  uvx harbor run
  -d "$DATASET"
  --agent-import-path bench.harbor.gemma_cli_agent:GemmaCliAgent
  --model "$MODEL"
  --agent-kwarg "ollama_url=$OLLAMA_URL"
  --agent-kwarg "max_turns=$MAX_TURNS"
  --agent-kwarg "max_tokens=$MAX_TOKENS"
  --agent-kwarg "think=$THINK"
  --agent-kwarg "shell_idle_timeout_ms=$SHELL_IDLE_TIMEOUT_MS"
  --n-attempts "$N_ATTEMPTS"
  --n-concurrent "$N_CONCURRENT"
  --timeout-multiplier "$TIMEOUT_MULTIPLIER"
  --jobs-dir "$JOBS_DIR"
  --job-name "$JOB_NAME"
)

if [[ "$GEMMA_PACKAGE" == "local" ]]; then
  args+=(--agent-kwarg "core_tarball=$core_tarball")
  args+=(--agent-kwarg "cli_tarball=$cli_tarball")
else
  args+=(--agent-kwarg "gemma_package=$GEMMA_PACKAGE")
fi

args+=(-y)

if [[ -n "${TASK:-}" ]]; then
  args+=(--include-task-name "$TASK")
  if [[ -z "${N_TASKS:-}" ]]; then
    args+=(--n-tasks "1")
  fi
fi

if [[ -n "${INCLUDE_TASK_NAME:-}" ]]; then
  args+=(--include-task-name "$INCLUDE_TASK_NAME")
fi

if [[ -n "${EXCLUDE_TASK_NAME:-}" ]]; then
  args+=(--exclude-task-name "$EXCLUDE_TASK_NAME")
fi

if [[ -n "${N_TASKS:-}" ]]; then
  args+=(--n-tasks "$N_TASKS")
fi

if [[ "${UPLOAD:-0}" == "1" ]]; then
  args+=(--upload)
fi

cat <<EOF
Running Terminal-Bench v2 with Gemma CLI
  command:        scripts/run-tbench2-gemma31b.sh
  dataset:        $DATASET
  model:          $MODEL
  package:        $package_label
  ollama url:     $OLLAMA_URL
  attempts:       $N_ATTEMPTS
  concurrency:    $N_CONCURRENT
  timeout x:      $TIMEOUT_MULTIPLIER
  max turns:      $MAX_TURNS
  max tokens:     $MAX_TOKENS
  think:          $THINK
  shell idle ms:  $SHELL_IDLE_TIMEOUT_MS
  jobs dir:       $JOBS_DIR
  job name:       $JOB_NAME

Optional overrides:
  GEMMA_PACKAGE=local             Pack and install this checkout inside each task container
  GEMMA_PACKAGE=gemma-cli@<version> Pin a specific published package version
  TASK=configure-git-webserver   Run one registry task by name
  INCLUDE_TASK_NAME='regex-*'    Filter tasks by name glob
  N_TASKS=10                     Run the first N selected tasks
  MAX_TURNS=32                   Lower the per-task budget for quick smoke runs
  MAX_TOKENS=8192                Raise the per-response output cap for harder tasks
  THINK=on                       Re-enable provider thinking for comparison runs
  SHELL_IDLE_TIMEOUT_MS=180000   Lower quiet-command timeout for quick smoke runs
  TIMEOUT_MULTIPLIER=3           Lower Harbor's benchmark timeout multiplier
  UPLOAD=1                       Upload results after completion

EOF

printf 'Command:'
printf ' %q' "${args[@]}"
printf '\n\n'

"${args[@]}"
