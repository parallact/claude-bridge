FROM node:22-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ src/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist/ dist/
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3456/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
