FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    PRA_HOST=0.0.0.0 \
    PRA_PORT=8787

# No runtime dependencies: the server uses only Node built-ins.
COPY package.json ./
COPY src ./src
COPY web ./web

USER node
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "src/main.ts"]
