# Single-stage image: the custom server (server.ts) and the db/seed scripts run through tsx,
# so the full dependency tree is kept. Fine for a demo; see README limitations.
FROM node:22-alpine
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
EXPOSE 3000
USER node
CMD ["npm", "start"]
