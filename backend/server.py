from fastapi import FastAPI
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import asyncpg
import os
from pathlib import Path

from routes.auth import router as auth_router
from routes.dashboard import router as dashboard_router
from routes.clasificacion import router as clasificacion_router
from routes.productos import router as productos_router
from routes.clientes import router as clientes_router
from routes.tiendas import router as tiendas_router
from routes.departamentos import router as departamentos_router
from routes.reservas import router as reservas_router
from routes.alertas import router as alertas_router
from routes.proyeccion import router as proyeccion_router
from routes.catalogos import router as catalogos_router
from routes.productos_odoo import router as productos_odoo_router
from routes.stock import router as stock_router
from routes.produccion import router as produccion_router
from routes.inventario import router as inventario_router
from routes.config_stock import router as config_stock_router
from routes.export import router as export_router
from routes.sync import router as sync_router
from migrations.startup_ddl import ensure_startup_ddl
from db import get_pool, close_pool, safe_acquire
import auth_utils  # noqa: F401

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

app = FastAPI(title="Ventas API", version="0.1.0")


@app.exception_handler(asyncpg.exceptions.ConnectionDoesNotExistError)
async def db_connection_error_handler(request, exc):
    import db as _db
    try:
        if _db.pool and not _db.pool._closed:
            await _db.pool.close()
    except Exception:
        pass
    _db.pool = None
    return JSONResponse(status_code=503, content={"detail": "Conexión BD perdida. Reintente."})


@app.exception_handler(asyncpg.exceptions.InterfaceError)
async def db_interface_error_handler(request, exc):
    import db as _db
    try:
        if _db.pool and not _db.pool._closed:
            await _db.pool.close()
    except Exception:
        pass
    _db.pool = None
    return JSONResponse(status_code=503, content={"detail": "Error BD. Reintente."})


@app.on_event("startup")
async def startup():
    await get_pool()
    await ensure_startup_ddl()


@app.on_event("shutdown")
async def shutdown():
    await close_pool()


_cors_origins_raw = os.environ.get("CORS_ORIGINS", "*")
_cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]

if _cors_origins == ["*"]:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r".*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(auth_router)
app.include_router(dashboard_router)
app.include_router(clasificacion_router)
app.include_router(productos_router)
app.include_router(clientes_router)
app.include_router(tiendas_router)
app.include_router(departamentos_router)
app.include_router(reservas_router)
app.include_router(alertas_router)
app.include_router(proyeccion_router)
app.include_router(catalogos_router)
app.include_router(productos_odoo_router)
app.include_router(stock_router)
app.include_router(produccion_router)
app.include_router(inventario_router)
app.include_router(config_stock_router)
app.include_router(export_router)
app.include_router(sync_router)


@app.get("/api/health")
async def health_check():
    try:
        async with safe_acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "db": "connected", "module": "ventas"}
    except Exception as e:
        return {"status": "degraded", "db": str(e)}
