# Multi-stage image: the build stage compiles with devDependencies, then prunes
# them; the runtime stage carries only prod deps + build output. The custom
# server (server.ts) still runs through tsx, which is a production dependency.

# --- build -------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund

# --- runtime -----------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/server.ts /app/tsconfig.json /app/next.config.ts ./
COPY --from=build /app/src ./src
# Migrations + setup scripts so `npm run db:setup` works inside the image.
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
EXPOSE 3000
USER node
CMD ["npm", "start"]
