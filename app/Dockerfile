FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# `output: 'standalone'` (next.config.mjs) bundles the server with only the
# node_modules subset it needs; static assets and public/ ride alongside.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
# The standalone server honours PORT (set to 3000 in compose) and binds HOSTNAME.
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
