FROM node:24-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @hroshi/server db:generate \
  && pnpm --filter @hroshi/web build

FROM base AS runtime
ENV NODE_ENV=production TZ=Europe/Madrid
COPY --from=build /app /app
EXPOSE 4300
CMD ["node", "apps/server/src/api.ts"]

# Speech-to-text for voice messages. Built for the Pi 5's Cortex-A76, not for the build machine:
# a native build on an Apple chip would use instructions the Pi lacks.
FROM base AS whisper
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
  && git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp /src \
  && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
    -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16 -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF \
  && cmake --build /build -j --target whisper-cli

# The chat bot drives Claude Code headless; only this image carries it. opusdec turns Telegram's
# OGG voice notes into WAV, which whisper-cli reads.
FROM runtime AS bot
RUN apt-get update \
  && apt-get install -y --no-install-recommends opus-tools \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@2.1.323
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
CMD ["node", "apps/server/src/bot.ts"]
