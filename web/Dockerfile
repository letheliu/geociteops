# geociteops 前端镜像（Vue 3 + Vite → nginx 静态托管 + 反向代理后端）
#
# 构建上下文必须是仓库根：web 的类型链经 sdk/src/types.ts 指向根 src/router.js
# （整个后端路由树都进 vue-tsc 的类型图），因此依赖根 lockfile、src/ 源码与
# prisma schema。compose 里以 `context: .` + `dockerfile: web/Dockerfile` 声明。
#
# 构建链 node:22-slim（与后端镜像同版本：pnpm 11 引用 node:sqlite，需 Node ≥22.5）；
# 运行期 nginx:alpine 只托管静态文件、做反代，无原生依赖，alpine 安全。

ARG NODE_IMAGE=node:22-slim
ARG NGINX_IMAGE=nginx:alpine
ARG PNPM_VERSION=11.22.0

# ---------- build：prisma generate → vue-tsc -b && vite build ----------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
# /pnpm/bin：pnpm 11 全局 bin 目录（与后端 Dockerfile 同款约束）
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
# openssl：@prisma/engines 探测 SSL 版本用，缺失会选错引擎（同后端 Dockerfile）
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json ./sdk/
COPY web/package.json ./web/
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
# sdk 类型链 → src/router.js → @prisma/client：不 generate 则 vue-tsc 报缺类型
RUN pnpm exec prisma generate

COPY tsconfig.json tsconfig.build.json ./
COPY sdk ./sdk
COPY web ./web
COPY src ./src
RUN pnpm --filter geociteops-web build

# ---------- runtime：nginx 托管 dist + 反代 /trpc /files /health /webhooks ----------
FROM ${NGINX_IMAGE} AS runtime

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 80
