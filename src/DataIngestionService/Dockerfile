FROM oven/bun:1.4.2 AS bun

FROM bun AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM bun AS production-dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

FROM dependencies AS build
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/copy-evidence-skills.mjs ./scripts/copy-evidence-skills.mjs
COPY scripts/stamp-evidence-dependencies.mjs ./scripts/stamp-evidence-dependencies.mjs
RUN bun run build

FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=production-dependencies --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
USER pwuser
EXPOSE 8080
CMD ["bun", "dist/src/index.js"]
