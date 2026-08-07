#!/usr/bin/env bash
#
# Start or stop the local Postgres and Redis that the test suites need.
#
# Prefers Docker Compose. Falls back to natively-installed binaries when no
# Docker daemon is reachable — CI runners and sandboxed containers often have
# the client without the daemon, and the migration tests need a real Postgres
# either way.
set -euo pipefail

readonly PG_PORT="${PG_PORT:-5432}"
readonly PG_DATA="${PG_DATA:-.data/postgres}"
readonly PG_SOCKET_DIR="${PG_SOCKET_DIR:-/tmp}"
readonly PG_LOG="${PG_LOG:-.data/postgres.log}"
readonly REDIS_PORT="${REDIS_PORT:-6379}"
readonly REDIS_LOG="${REDIS_LOG:-.data/redis.log}"

has_docker_daemon() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

find_pg_bin() {
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return 0
  fi
  local candidate
  candidate=$(find /usr/lib/postgresql -maxdepth 2 -name pg_ctl -type f 2>/dev/null | sort -V | tail -1)
  if [[ -n "${candidate}" ]]; then
    dirname "${candidate}"
    return 0
  fi
  return 1
}

native_up() {
  local pg_bin
  if ! pg_bin=$(find_pg_bin); then
    echo "error: no Docker daemon and no PostgreSQL installation found." >&2
    echo "Install Docker, or PostgreSQL 16, then re-run." >&2
    exit 1
  fi

  mkdir -p "$(dirname "${PG_LOG}")"

  if [[ ! -d "${PG_DATA}" ]]; then
    echo "Initialising PostgreSQL cluster in ${PG_DATA}"
    "${pg_bin}/initdb" -D "${PG_DATA}" -U postgres --auth=trust >/dev/null
  fi

  if "${pg_bin}/pg_ctl" -D "${PG_DATA}" status >/dev/null 2>&1; then
    echo "PostgreSQL already running"
  else
    "${pg_bin}/pg_ctl" -D "${PG_DATA}" -l "${PG_LOG}" \
      -o "-p ${PG_PORT} -k ${PG_SOCKET_DIR}" start >/dev/null
    echo "PostgreSQL started on port ${PG_PORT}"
  fi

  if redis-cli -p "${REDIS_PORT}" ping >/dev/null 2>&1; then
    echo "Redis already running"
  else
    redis-server --daemonize yes --port "${REDIS_PORT}" --logfile "$(pwd)/${REDIS_LOG}"
    echo "Redis started on port ${REDIS_PORT}"
  fi
}

native_down() {
  local pg_bin
  if pg_bin=$(find_pg_bin) && "${pg_bin}/pg_ctl" -D "${PG_DATA}" status >/dev/null 2>&1; then
    "${pg_bin}/pg_ctl" -D "${PG_DATA}" stop >/dev/null
    echo "PostgreSQL stopped"
  fi
  if redis-cli -p "${REDIS_PORT}" ping >/dev/null 2>&1; then
    redis-cli -p "${REDIS_PORT}" shutdown nosave >/dev/null 2>&1 || true
    echo "Redis stopped"
  fi
}

main() {
  local command="${1:-up}"
  case "${command}" in
    up)
      if has_docker_daemon; then
        docker compose up -d --wait
      else
        echo "No Docker daemon reachable; using native services."
        native_up
      fi
      ;;
    down)
      if has_docker_daemon; then
        docker compose down
      else
        native_down
      fi
      ;;
    *)
      echo "usage: $0 {up|down}" >&2
      exit 1
      ;;
  esac
}

main "$@"
