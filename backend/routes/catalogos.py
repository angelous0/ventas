"""Catálogos de clasificación — read-only desde schema produccion.

Endpoints para poblar dropdowns del modal de clasificación de productos.
"""
from fastapi import APIRouter, Depends
from auth_utils import get_current_user
from db import get_pool

router = APIRouter(prefix="/api/catalogos")


CATALOGOS = {
    "marcas": "produccion.prod_marcas",
    "tipos": "produccion.prod_tipos",
    "entalles": "produccion.prod_entalles",
    "telas": "produccion.prod_telas",
    "telas-general": "produccion.prod_telas_general",
    "generos": "produccion.prod_generos",
    "cuellos": "produccion.prod_cuellos",
    "detalles": "produccion.prod_detalles",
    "lavados": "produccion.prod_lavados",
    "hilos": "produccion.prod_hilos",
}


async def _list(tabla: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(f"SELECT id, nombre FROM {tabla} ORDER BY nombre ASC")
        return [{"id": r["id"], "nombre": r["nombre"]} for r in rows]


@router.get("/marcas")
async def get_marcas(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["marcas"])


@router.get("/tipos")
async def get_tipos(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["tipos"])


@router.get("/entalles")
async def get_entalles(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["entalles"])


@router.get("/telas")
async def get_telas(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["telas"])


@router.get("/telas-general")
async def get_telas_general(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["telas-general"])


@router.get("/generos")
async def get_generos(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["generos"])


@router.get("/cuellos")
async def get_cuellos(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["cuellos"])


@router.get("/detalles")
async def get_detalles(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["detalles"])


@router.get("/lavados")
async def get_lavados(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["lavados"])


@router.get("/hilos")
async def get_hilos(_u: dict = Depends(get_current_user)):
    return await _list(CATALOGOS["hilos"])


@router.get("/tiendas")
async def get_tiendas(_u: dict = Depends(get_current_user)):
    """Lista de tiendas reales (x_nombre de stock_location).

    Excluye almacenes técnicos (Abastecimiento, Ajuste, Clientes, Proveedores,
    Fallados, Ajuste). Sirve para poblar dropdowns de filtros.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT DISTINCT x_nombre AS nombre
            FROM odoo.stock_location
            WHERE x_nombre IS NOT NULL AND x_nombre <> ''
              AND x_nombre NOT IN ('Abastecimiento', 'Ajuste', 'Clientes',
                                    'Proveedores', 'Fallados Qepo')
            ORDER BY x_nombre ASC;
        """)
        return [{"value": r["nombre"], "label": r["nombre"]} for r in rows]
