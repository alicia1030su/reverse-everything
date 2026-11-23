FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY examples ./examples
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund && npm run build && npx playwright install chromium && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright RE_HOST=0.0.0.0 RE_PORT=4173 RE_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/examples ./examples
COPY --from=build /app/scripts ./scripts
COPY package.json package-lock.json ./
COPY --from=build /ms-playwright /ms-playwright
RUN npx playwright install-deps chromium >/dev/null && useradd --create-home --uid 10001 re && mkdir -p /data && chown -R re:re /data /app
USER re
EXPOSE 4173
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/start.mjs"]
