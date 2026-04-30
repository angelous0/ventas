# Despliegue en EasyPanel

Guía paso a paso para desplegar el módulo Ventas en [EasyPanel](https://easypanel.io/).
Asume que ya tenés EasyPanel instalado y un proyecto creado.

## Arquitectura

Dos servicios separados con sus propios dominios:

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  ventas-frontend            │         │  ventas-backend              │
│  https://ventas.midom.com   │ ───────▶│  https://api.ventas.midom.com│
│  React + nginx, port 80     │  HTTPS  │  FastAPI + uvicorn, port 8003│
└─────────────────────────────┘         └──────────────────────────────┘
                                                   │
                                                   ▼
                                          PostgreSQL externo
                                          (host:puerto/datos)
```

El frontend lee `REACT_APP_BACKEND_URL` en BUILD TIME (no runtime), así que la URL
del backend queda incrustada en el bundle. Cambiarla requiere rebuild.

---

## 1. Servicio backend

### En EasyPanel

1. **Create Service → App**
2. **Source**: GitHub
   - Repo: `angelous0/ventas`
   - Branch: `main`
   - Build Path: `backend` ← importante, es el subdirectorio
3. **Build Method**: Dockerfile (lo detecta automáticamente desde `backend/Dockerfile`)
4. **Port**: `8003`
5. **Domain**: `api.ventas.tudominio.com` (HTTPS automático)
6. **Environment Variables**:

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `postgres://USUARIO:PASS@HOST:PUERTO/datos?sslmode=disable&options=-csearch_path%3Dpublic,odoo,produccion` |
   | `JWT_SECRET_KEY` | Generar con `openssl rand -hex 32` (¡no reusar entre entornos!) |
   | `CORS_ORIGINS` | `https://ventas.tudominio.com` (el dominio del frontend) |

7. **Healthcheck**: Path `/api/health`, Port `8003`
8. **Deploy** → primer build tarda ~3 min.

### Verificación

```bash
curl https://api.ventas.tudominio.com/api/health
# → {"status":"ok","db":"connected","module":"ventas"}
```

Si dice `degraded`, revisar `DATABASE_URL` y que el host PostgreSQL acepte
conexiones desde la IP de EasyPanel.

---

## 2. Servicio frontend

### En EasyPanel

1. **Create Service → App**
2. **Source**: GitHub
   - Repo: `angelous0/ventas`
   - Branch: `main`
   - Build Path: `frontend`
3. **Build Method**: Dockerfile
4. **Port**: `80`
5. **Domain**: `ventas.tudominio.com`
6. **Build Args** ← importante:

   | Arg | Valor |
   |---|---|
   | `REACT_APP_BACKEND_URL` | `https://api.ventas.tudominio.com` |

   *(EasyPanel los pasa al `docker build`. No usar Environment Variables —
   esas son runtime y no llegan al build.)*

7. **Deploy** → primer build tarda ~5 min (npm install + craco build).

### Verificación

Abrir `https://ventas.tudominio.com` → ver pantalla de login. Si la consola del
navegador muestra `CORS error`, revisar `CORS_ORIGINS` del backend.

---

## 3. Auto-deploy en push

EasyPanel ofrece webhooks de GitHub: cada `git push origin main` redespliega
automáticamente. Activarlo en **Service → Deployments → Auto Deploy ON**.

Tip: el frontend tarda más en buildear que el backend porque hace
`npm install`. Si solo cambiás backend, podés desactivar auto-deploy del
frontend para no rebuildear innecesariamente.

---

## 4. Recursos sugeridos

| Servicio | RAM | CPU | Disco |
|---|---|---|---|
| backend  | 512 MB | 0.5 vCPU | 1 GB |
| frontend | 128 MB | 0.25 vCPU (solo nginx) | 200 MB |

El backend hace queries pesadas (EWMA, joins multi-tabla); si las
consultas tardan, subir RAM antes que CPU. Postgres siempre externo.

---

## 5. Variables sensibles — checklist

- [ ] `JWT_SECRET_KEY` único por entorno (no reusar el de dev en prod)
- [ ] `DATABASE_URL` con usuario read-write pero sin permisos de DDL si se puede
- [ ] `CORS_ORIGINS` específico, **NO** `*` en producción
- [ ] HTTPS forzado en ambos dominios (EasyPanel lo hace por defecto)
- [ ] `.env` NUNCA commiteado (ya está en `.gitignore`)

---

## 6. Troubleshooting

**Frontend muestra "Network Error" al login**
→ Probablemente `REACT_APP_BACKEND_URL` apunta mal. Verificar en DevTools
   Network tab a qué URL hace request el login. Reconstruir el frontend con
   el valor correcto.

**Backend responde 503 "Error BD"**
→ El pool de asyncpg perdió conexión. Esperar ~10s o reiniciar el servicio.
   Si persiste, verificar que el host Postgres acepte conexiones desde la IP
   de EasyPanel (whitelist).

**Login OK pero todas las páginas dicen "No autenticado"**
→ El token JWT se firma con `JWT_SECRET_KEY`. Si la cambiaste tras emitir
   tokens, los viejos quedan inválidos. Cerrar sesión y reloguear.

**Build del frontend falla con "out of memory"**
→ EasyPanel por defecto da 1GB al build. Subir el límite del builder en
   Service → Build → Memory Limit a 2 GB.

**Cambios en backend no se reflejan tras push**
→ EasyPanel solo rebuildea archivos del Build Path configurado. Si tu push
   tocó solo `frontend/`, el backend no se redespliega (correcto).

---

## 7. Setup local para desarrollo (opcional)

Si querés correr ambos servicios localmente con Docker:

```bash
# Backend
cd backend
cp .env.example .env  # editar con valores reales
docker build -t ventas-backend .
docker run -p 8003:8003 --env-file .env ventas-backend

# Frontend
cd frontend
docker build \
  --build-arg REACT_APP_BACKEND_URL=http://localhost:8003 \
  -t ventas-frontend .
docker run -p 3003:80 ventas-frontend
```

O sin Docker (más rápido para iterar):

```bash
# Backend
cd backend && pip install -r requirements.txt
python -m uvicorn server:app --reload --port 8003

# Frontend
cd frontend && npm install
npm start  # toma REACT_APP_BACKEND_URL del .env
```
