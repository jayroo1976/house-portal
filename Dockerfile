FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --omit=optional

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends rclone ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
RUN chmod +x entrypoint.sh && mkdir -p /data /config
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 RCLONE_CONFIG=/config/rclone.conf
VOLUME ["/data", "/config"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "server.js"]
