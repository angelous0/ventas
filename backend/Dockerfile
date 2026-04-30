# Backend FastAPI · Ventas
# Python 3.11 (compatible con asyncpg y todas las deps).
# Build: docker build -t ventas-backend .
# Run:   docker run -p 8003:8003 --env-file .env ventas-backend
FROM python:3.11-slim

# Dependencias del sistema mínimas
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       libpq-dev \
       curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar deps primero (mejor caching)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Código de la app
COPY . .

# Healthcheck para que EasyPanel detecte caídas
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8003/api/health || exit 1

EXPOSE 8003

# Producción: SIN --reload, sin watcher de archivos.
# Workers > 1 da paralelismo real (ajustar según CPU del host).
CMD ["python", "-m", "uvicorn", "server:app", \
     "--host", "0.0.0.0", \
     "--port", "8003", \
     "--workers", "2"]
