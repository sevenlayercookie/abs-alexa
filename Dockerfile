FROM gcr.io/distroless/nodejs26:latest
WORKDIR /app

FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY lambda/package*.json ./lambda/
COPY express/package*.json ./express/
RUN npm ci --omit=dev
COPY lambda/ ./lambda
COPY express/ ./express

FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=builder /app/ ./

CMD ["express/server.js"]