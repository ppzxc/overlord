# 브라우저는 넣지 않는다. WITH_BROWSER는 브라우저 어댑터가 생길 때를 위한 자리다.
ARG NODE_VERSION=22
ARG WITH_BROWSER=false

# 의존성이 모두 순수 JS라 빌드 단계는 빌드 머신 아키텍처로 돌려도 결과가 같다(교차 빌드에 에뮬레이션이 필요 없다).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS build
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
# 설정 파일의 healthz.bind를 읽어 그 주소를 찌른다. 바인드를 바꿔도 여기는 그대로다.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/main.js", "healthcheck", "/config/config.yaml"]
CMD ["node", "dist/main.js", "/config/config.yaml"]
