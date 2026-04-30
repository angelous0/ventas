# Frontend React · Ventas
# Multi-stage: stage 1 buildea el bundle, stage 2 lo sirve con nginx.
#
# La URL del backend se inyecta en BUILD TIME (CRA fija REACT_APP_*
# en el bundle generado). Pasar via build arg:
#   docker build \
#     --build-arg REACT_APP_BACKEND_URL=https://api.ventas.midominio.com \
#     -t ventas-frontend .

# ─────────────────────── stage 1: build ───────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Build args inyectados por EasyPanel (o docker build --build-arg)
ARG REACT_APP_BACKEND_URL
ENV REACT_APP_BACKEND_URL=${REACT_APP_BACKEND_URL}

# Instalar deps con cache
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps

# Copiar fuente y buildear
COPY . .
RUN npm run build

# ─────────────────────── stage 2: serve ───────────────────────
FROM nginx:1.27-alpine

# Copiar el bundle estático
COPY --from=builder /app/build /usr/share/nginx/html

# Configuración nginx que soporta SPA (rutas client-side)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Healthcheck — nginx responde 200 en /
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
