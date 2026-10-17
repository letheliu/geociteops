# syntax=docker/dockerfile:1
#
# geociteops 后端镜像（Fastify + tRPC + Prisma + zvec）
#
# 四阶段：deps(全量依赖) → build(prisma generate + tsc) → prod-deps(仅生产依赖) → runtime
# 另导出 migrate 阶段（带 prisma CLI）供 compose 的一次性迁移服务使用。
#
# 基础镜像用 node:22-slim（Debian 系）而非 alpine：
# @zvec/zvec 是原生绑定（@zvec/bindings-linux-x64），alpine 的 musl 生态无预编译产物，
# 用 slim 换兼容性，镜像体积换不来编译稳定性。
# Node 必须 ≥22：pnpm 11 引用 node:sqlite（Node 22.5+ 才有），在 Node 20 上
# pnpm install 直接抛 ERR_UNKNOWN_BUILTIN_MODULE（lc 实构建发现，2026-10-17）。

ARG NODE_IMAGE=node:22-slim
ARG PNPM_VERSION=11.22.0

# ---------- deps：装全量依赖（含 devDependencies，供 build 阶段编译与 prisma generate 用）----------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# openssl：pnpm install 触发 @prisma/engines 下载时用于探测 SSL 版本，
# 缺失时 Prisma 默认选 debian-openssl-1.1.x 引擎，到 runtime（openssl 3）加载即崩
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app
# 只拷清单文件，让依赖层可被源码改动复用；lockfile 一律 frozen，杜绝解析漂移
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json ./sdk/
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

# ---------- build：生成 Prisma client 并编译 TS ----------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/sdk/node_modules ./sdk/node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY prisma ./prisma
COPY scripts ./scripts

# pnpm-workspace.yaml 的 allowBuilds 已放行 prisma / @prisma/client / @zvec/zvec 的构建脚本
RUN pnpm exec prisma generate
RUN pnpm exec tsc -p tsconfig.build.json

# ---------- prod-deps：仅生产依赖 + 生成 Prisma client ----------
# pnpm 布局下 prisma generate 的产物落在 .pnpm 虚拟店内的 @prisma/client 包旁，
# 根级 node_modules/.prisma 不存在——client 必须在「最终随镜像出货的这套
# node_modules」里就地 generate，跨阶段 COPY 产物路径对不上（lc 实构建发现）。
# 因此 prisma CLI 移入 dependencies（见 package.json），本阶段安装后自行 generate。
FROM ${NODE_IMAGE} AS prod-deps
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json ./sdk/
COPY web/package.json ./web/
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --prod
RUN pnpm exec prisma generate

# ---------- migrate：一次性 prisma migrate deploy ----------
# 直接复用 build 阶段（带 prisma CLI devDependency），免得把 CLI 塞进生产镜像
FROM ${NODE_IMAGE} AS migrate
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/sdk/node_modules ./sdk/node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm exec prisma generate
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---------- runtime：生产镜像 ----------
FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
# openssl：Prisma 查询引擎依赖；ca-certificates：adapter 走 https 出网
# zvec 原生绑定若在 slim 上缺系统库，在此处补 apt 依赖（见 M1 风险表）
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# tsx：演示站每日 `pnpm demo:reset` 需要经 tsx 执行依赖 TS 源码的
# reset-demo.mjs / seed-demo.mjs（§3.6 职责②）。tsx 是 devDependency，
# 生产依赖树里没有，故全局补装一个，不改动 package.json 的依赖分类。
ENV PNPM_HOME=/pnpm
# /pnpm/bin 是 pnpm 11 的全局 bin 目录：构建期 pnpm add --global 校验它必须在 PATH，
# 运行期 tsx 也装在那里（compose 的 demo:reset 依赖）——两个阶段都要包含
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && pnpm add --global tsx@4.16.0

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
# pnpm 11 跑脚本前默认做 deps-status 检查（打 registry，容器内慢网可挂死数分钟，
# lc 实测 pnpm demo:reset/admin:bootstrap 均挂）。镜像内依赖已按 lockfile frozen
# 安装完毕，无需运行时复核——关闭它，compose exec pnpm <script> 才可用。
ENV npm_config_verify_deps_before_run=false

COPY --from=prod-deps /app/node_modules ./node_modules
# Prisma client 已在 prod-deps 阶段就地 generate（pnpm store 路径自洽），无需跨阶段覆盖
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
# 防御性规范化：Windows 检出可能带 CRLF（shebang 变 'bash\r'，lc 实构建踩过）
# + exec bit（git index 已设 +x，这里兜底）
RUN sed -i 's/\r$//' /app/scripts/docker-entrypoint.sh \
  && chmod +x /app/scripts/docker-entrypoint.sh
# 运维脚本随镜像走（演示站每日重置要用）
COPY --from=build /app/scripts ./scripts
# src 源码：reset-demo / seed-demo 经 tsx 运行时要 import src/core 下的信封与向量模块
COPY --from=build /app/src ./src

# 向量库与上传目录：compose 会把命名卷挂到这两个路径
RUN mkdir -p /app/data/zvec /app/data/uploads

EXPOSE 4000
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
