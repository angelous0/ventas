"""Configuración de TOPES de stock por (tienda × tipo).

Tabla: produccion.config_stock_max (creada en startup_ddl.py)

Endpoints:
- GET  /api/config/stock-max?tienda=...      → lista config (tienda opcional)
- PUT  /api/config/stock-max                 → upsert una fila
- POST /api/config/stock-max/bulk            → upsert N filas (matriz completa)
- GET  /api/config/stock-max/sugerencia      → max histórico por (tienda, tipo)
                                                en los últimos 12m, para
                                                autopopular la matriz.

El tope se interpreta como **máximo de unidades por SKU** (variante color×talla)
para una combinación tienda×tipo. /reposicion lo aplica como cap duro.
"""
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, conint

from auth_utils import get_current_user
from db import get_pool
from helpers import VENTA_REAL_FROM, VENTA_REAL_WHERE  # noqa: F401 (sugerencia hist usa stock_quant histórico)

router = APIRouter(prefix="/api/config")


class StockMaxItem(BaseModel):
    tienda_codigo: str = Field(..., min_length=1, max_length=50)
    tipo_nombre: str = Field(..., min_length=1, max_length=80)
    stock_max_por_sku: conint(gt=0) = 50  # > 0 garantizado por CHECK
    activo: bool = True


class StockMaxBulkInput(BaseModel):
    items: List[StockMaxItem]


@router.get("/stock-max")
async def list_stock_max(
    tienda: Optional[str] = Query(None, description="Si se pasa, filtra a esa tienda"),
    incluir_inactivos: bool = Query(False),
    _u: dict = Depends(get_current_user),
):
    """Lista las filas de config_stock_max. Si `tienda` se omite, devuelve todas."""
    pool = await get_pool()
    where = []
    params: list = []
    if tienda:
        params.append(tienda)
        where.append(f"tienda_codigo = ${len(params)}")
    if not incluir_inactivos:
        where.append("activo = TRUE")
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT tienda_codigo, tipo_nombre, stock_max_por_sku, activo,
                   created_at, updated_at
            FROM produccion.config_stock_max
            {where_sql}
            ORDER BY tienda_codigo, tipo_nombre;
            """,
            *params,
        )
    return {
        "items": [
            {
                "tienda_codigo": r["tienda_codigo"],
                "tipo_nombre": r["tipo_nombre"],
                "stock_max_por_sku": r["stock_max_por_sku"],
                "activo": r["activo"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
            for r in rows
        ],
        "total": len(rows),
    }


@router.put("/stock-max")
async def upsert_stock_max(item: StockMaxItem, _u: dict = Depends(get_current_user)):
    """Upsert de UNA combinación (tienda × tipo)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO produccion.config_stock_max
                (tienda_codigo, tipo_nombre, stock_max_por_sku, activo, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (tienda_codigo, tipo_nombre) DO UPDATE
                SET stock_max_por_sku = EXCLUDED.stock_max_por_sku,
                    activo            = EXCLUDED.activo,
                    updated_at        = NOW();
            """,
            item.tienda_codigo, item.tipo_nombre, item.stock_max_por_sku, item.activo,
        )
    return {"ok": True, "item": item.dict()}


@router.post("/stock-max/bulk")
async def bulk_upsert_stock_max(
    payload: StockMaxBulkInput,
    _u: dict = Depends(get_current_user),
):
    """Upsert masivo. Acepta hasta 500 filas en una sola transacción."""
    if len(payload.items) > 500:
        raise HTTPException(400, "Demasiados items (máx 500 por batch)")
    if not payload.items:
        return {"ok": True, "guardados": 0}

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for it in payload.items:
                await conn.execute(
                    """
                    INSERT INTO produccion.config_stock_max
                        (tienda_codigo, tipo_nombre, stock_max_por_sku, activo, updated_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT (tienda_codigo, tipo_nombre) DO UPDATE
                        SET stock_max_por_sku = EXCLUDED.stock_max_por_sku,
                            activo            = EXCLUDED.activo,
                            updated_at        = NOW();
                    """,
                    it.tienda_codigo, it.tipo_nombre, it.stock_max_por_sku, it.activo,
                )
    return {"ok": True, "guardados": len(payload.items)}


@router.get("/stock-max/sugerencia")
async def sugerencia_historica(
    tienda: Optional[str] = Query(None, description="Si se pasa, filtra a esa tienda"),
    meses: int = Query(12, ge=1, le=36),
    percentil: int = Query(95, ge=50, le=100,
        description="Percentil del stock observado a usar como sugerencia (95 por defecto)"),
    _u: dict = Depends(get_current_user),
):
    """Sugerencia de tope basada en el percentil P95 del stock observado por SKU
    en los últimos N meses.

    Idea: si históricamente esa tienda llegó a tener hasta X unidades de un
    SKU de tipo Y, ese X es un techo realista. Usamos P95 (no max absoluto)
    para descartar outliers.

    NOTA: usamos `stock_quant` actual como aproximación; idealmente se
    requeriría snapshots históricos. Como compromiso: tomamos el MAX del stock
    actual por SKU (variante) y lo redondeamos al alza al múltiplo de 10 más
    cercano (decisión conservadora).
    """
    pool = await get_pool()
    # $1 = percentil, luego van los filtros opcionales.
    params: list = [percentil]
    where_t = ""
    if tienda:
        params.append(tienda)
        where_t = f"AND sl.x_nombre = ${len(params)}"

    # P95 de stock por (tienda × tipo) sobre stock_quant actual.
    # Cuando haya snapshots históricos, esto se reemplaza por SELECT sobre
    # la tabla de snapshots con date_trunc('day', ...).
    sql = f"""
    WITH stock_skus AS (
        SELECT
            sl.x_nombre AS tienda,
            COALESCE(ti.nombre, ti_auto.nombre, NULLIF(pt.tipo, ''), '— sin tipo —') AS tipo,
            pp.odoo_id AS pp_id,
            SUM(q.qty)::numeric AS stock
        FROM odoo.stock_quant q
        JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
        JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
        JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
        LEFT JOIN produccion.prod_tipos ti_auto
            ON pe.tipo_id IS NULL AND pt.tipo <> ''
            AND LOWER(TRIM(ti_auto.nombre)) = LOWER(TRIM(SPLIT_PART(pt.tipo, ' ', 1)))
        WHERE q.qty > 0
          AND sl.usage = 'internal' AND sl.active = true
          AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
          {where_t}
        GROUP BY 1, 2, 3
        HAVING SUM(q.qty) > 0
    )
    SELECT
        tienda, tipo,
        COUNT(DISTINCT pp_id)::int AS skus_observados,
        PERCENTILE_CONT($1::float / 100) WITHIN GROUP (ORDER BY stock)::numeric AS p_observado,
        MAX(stock)::int AS max_observado
    FROM stock_skus
    GROUP BY 1, 2
    ORDER BY 1, 2;
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    def _redondear(v: float) -> int:
        # Redondear al alza al múltiplo de 10 (más conservador → más alto)
        if v is None:
            return 50
        x = max(int(v), 1)
        return ((x + 9) // 10) * 10

    items = []
    for r in rows:
        sug = _redondear(float(r["p_observado"] or 0))
        items.append({
            "tienda_codigo": r["tienda"],
            "tipo_nombre":   r["tipo"],
            "stock_max_sugerido": sug,
            "p_observado": int(r["p_observado"] or 0),
            "max_observado": int(r["max_observado"] or 0),
            "skus_observados": int(r["skus_observados"] or 0),
        })
    return {
        "items": items,
        "percentil": percentil,
        "meses": meses,
        "metodo": "p_actual_redondeado_a_10",
    }
