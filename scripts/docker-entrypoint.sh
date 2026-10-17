#!/usr/bin/env bash
# app 容器启动前等待数据库端口就绪。
#
# 迁移由独立的 migrate 服务完成（compose 里 app 依赖 migrate 的
# service_completed_successfully），本脚本**不做任何迁移**，只做轻量端口等待与日志。
# 之所以还要等：migrate 退出成功意味着它那次的连接是通的，但 db 容器重启后
# 应用侧连接仍可能短暂处于拒绝态，留一层重试可消除这类偶发启动失败。
set -euo pipefail

DB_HOST="${GEO_DB_HOST:-db}"
DB_PORT="${GEO_DB_PORT:-5432}"
WAIT_TIMEOUT="${GEO_DB_WAIT_TIMEOUT:-60}"

log() { printf '[entrypoint] %s\n' "$*"; }

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

if [ "$#" -gt 0 ]; then
  log "启动： $*"
fi
exec "$@"
