#!/usr/bin/env bash
# app 容器启动前等待数据库端口就绪，并在 GEO_RUN_MIGRATIONS=1 时执行迁移。
#
# Compose 里迁移由独立的 migrate 服务完成（app 依赖它成功退出），
# 所以 compose 不设 GEO_RUN_MIGRATIONS。只有单独启动这个容器的平台
# （Render 等）才打开它。prisma migrate deploy 可重复执行。
# 等待仍然需要：migrate 退出成功只说明它那次连得上，db 重启后应用侧仍可能短暂拒绝。
set -euo pipefail

WAIT_TIMEOUT="${GEO_DB_WAIT_TIMEOUT:-60}"

log() { printf '[entrypoint] %s\n' "$*"; }

# Compose sets DATABASE_URL to the db service. Render and other hosts inject
# their own URL and have no hostname "db". Wait on the URL's host when it is set.
if [ -n "${DATABASE_URL:-}" ]; then
  parsed="$(node -e '
    const raw = process.env.DATABASE_URL || ""
    const u = new URL(raw.replace(/^postgres(ql)?:/i, "http:"))
    if (!u.hostname) process.exit(2)
    process.stdout.write(u.hostname + "\n" + (u.port || "5432"))
  ')" || {
    log "❌ DATABASE_URL 无法解析出主机名"
    exit 1
  }
  DB_HOST="$(printf '%s\n' "$parsed" | sed -n '1p')"
  DB_PORT="$(printf '%s\n' "$parsed" | sed -n '2p')"
else
  DB_HOST="${GEO_DB_HOST:-db}"
  DB_PORT="${GEO_DB_PORT:-5432}"
fi

log "等待数据库 ${DB_HOST}:${DB_PORT}（最多 ${WAIT_TIMEOUT}s）..."

elapsed=0
until timeout 1 bash -c "</dev/tcp/${DB_HOST}/${DB_PORT}" 2>/dev/null; do
  if [ "${elapsed}" -ge "${WAIT_TIMEOUT}" ]; then
    log "❌ 等待数据库超时（${WAIT_TIMEOUT}s），退出交由 compose 重启策略处理"
    exit 1
  fi
  if [ $((elapsed % 5)) -eq 0 ]; then
    log "… 仍在等待（${elapsed}s）"
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

log "✅ 数据库端口已就绪"

mkdir -p "${ZVEC_DATA_PATH:-/app/data/zvec}" "${GEO_UPLOAD_DIR:-/app/data/uploads}"

# Compose runs migrations in the migrate service. Hosts that only start this
# container set GEO_RUN_MIGRATIONS=1. prisma migrate deploy is idempotent.
case "${GEO_RUN_MIGRATIONS:-}" in
  1|true|on|yes)
    log "运行 prisma migrate deploy"
    ./node_modules/.bin/prisma migrate deploy
    ;;
esac

if [ "$#" -gt 0 ]; then
  log "启动： $*"
fi
exec "$@"
