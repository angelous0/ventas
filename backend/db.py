import asyncpg
import asyncio
import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL no configurado en .env")

pool = None

async def get_pool():
    global pool
    if pool is None or pool._closed:
        # min_size=0 → NO crear conexiones eagerly al arrancar el pool.
        # Esto evita que el startup se cuelgue 60s (timeout) si Postgres no
        # responde inmediatamente. Las conexiones se crean on-demand cuando
        # se hace acquire(). Mejor para deploys en EasyPanel/Docker donde
        # el container puede arrancar antes que la red esté lista.
        pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=0,
            max_size=10,
            timeout=10,           # 10s para acquire connection (era 60)
            command_timeout=30,
            max_inactive_connection_lifetime=30,
            server_settings={"search_path": "public,odoo,produccion"},
        )
    return pool

@asynccontextmanager
async def safe_acquire(max_retries=2):
    global pool
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            p = await get_pool()
            async with p.acquire() as conn:
                yield conn
                return
        except (asyncpg.exceptions.ConnectionDoesNotExistError,
                asyncpg.exceptions.InterfaceError,
                OSError) as e:
            last_error = e
            logger.warning(f"Conexión BD perdida (intento {attempt+1}/{max_retries+1}): {e}")
            try:
                if pool and not pool._closed:
                    await pool.close()
            except Exception:
                pass
            pool = None
            if attempt < max_retries:
                await asyncio.sleep(0.5 * (attempt + 1))
    raise last_error

async def close_pool():
    global pool
    if pool:
        await pool.close()
        pool = None
