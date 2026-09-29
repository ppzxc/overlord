# 브라우저는 넣지 않는다. WITH_BROWSER는 브라우저 어댑터가 생길 때를 위한 자리다.
ARG NODE_VERSION=22
ARG WITH_BROWSER=false

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-slim
ARG WITH_BROWSER
ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    WITH_BROWSER=${WITH_BROWSER}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
# 헬스체크는 컨테이너 안에서 기본 바인드(127.0.0.1:8080)를 찌른다. healthz.bind를 바꾸면 여기도 맞춘다.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js", "/config/config.yaml"]
