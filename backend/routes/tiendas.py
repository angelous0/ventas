"""Ventas por tienda + Pareto agrupado por x_nombre de stock_location."""
from fastapi import APIRouter, Depends, Query
from typing import Optional

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, VENTA_REAL_WHERE, CLIENTE_SELECT,
    rango_vista, ytd_rango, row_to_dict,
)

router = APIRouter(prefix="/api")


@router.get("/tiendas/ventas")
async def tiendas_ventas(
    vista: str = Query("ytd"),
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    anio_compara: Optional[int] = None,
    company_key: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    """Pareto de ventas por tienda (agrupado por stock_location.x_nombre).

    Si dos locations tienen el mismo x_nombre (ej. TALLER 91 y 204) se consolidan.
    Devuelve lista ordenada por ventas desc + pct_acumulado para análisis 80/20.
    """
    d, h = rango_vista(vista, desde, hasta)

    pool = await get_pool()
    async with pool.acquire() as conn:
        async def _agg(d_, h_):
            params: list = [d_, h_]
            where = ["v.date_order >= $1", "v.date_order <= $2", VENTA_REAL_WHERE,
                     "po.location_id IS NOT NULL"]
            if company_key and company_key != "all":
                params.append(company_key)
                where.append(f"v.company_key = ${len(params)}")
            sql = f"""
            WITH ord AS (
                SELECT DISTINCT v.order_id, po.location_id, po.amount_total,
                    {CLIENTE_SELECT} AS cliente_id
                {VENTA_REAL_FROM}
                WHERE {' AND '.join(where)}
            )
            SELECT
                -- Agrupación por x_nombre: TALLER 91 y TALLER 204 se consolidan
                COALESCE(NULLIF(sl.x_nombre, ''), 'loc ' || ord.location_id::text) AS tienda,
                SUM(ord.amount_total)::numeric(14,2) AS ventas,
                COUNT(*) AS tickets,
                COUNT(DISTINCT ord.cliente_id) AS clientes_unicos,
                (SUM(ord.amount_total) / NULLIF(COUNT(*), 0))::numeric(14,2) AS ticket_promedio,
                ARRAY_AGG(DISTINCT ord.location_id) AS location_ids,
                ARRAY_AGG(DISTINCT COALESCE(sl.complete_name, '')) FILTER (WHERE sl.complete_name IS NOT NULL) AS complete_names
            FROM ord
            LEFT JOIN odoo.stock_location sl ON sl.odoo_id = ord.location_id
            GROUP BY 1
            ORDER BY ventas DESC;
            """
            rows = await conn.fetch(sql, *params)
            return {r["tienda"]: row_to_dict(r) for r in rows}

        actual = await _agg(d, h)
        anterior = {}
        if anio_compara and vista == "ytd":
            d_a, h_a = ytd_rango(anio_compara, h)
            anterior = await _agg(d_a, h_a)

        total_ventas = sum(float(r["ventas"]) for r in actual.values())

        # Ordenar desc por ventas y calcular pct acumulado
        ordenadas = sorted(actual.items(), key=lambda x: -float(x[1]["ventas"]))
        items = []
        acumulado = 0.0
        for tienda, r in ordenadas:
            ventas = float(r["ventas"])
            acumulado += ventas
            share = round(ventas / total_ventas * 100, 2) if total_ventas > 0 else 0
            pct_acum = round(acumulado / total_ventas * 100, 2) if total_ventas > 0 else 0

            ant = anterior.get(tienda)
            var = None
            if ant and float(ant["ventas"]) > 0:
                var = round((ventas - float(ant["ventas"])) / float(ant["ventas"]) * 100, 2)

            items.append({
                "tienda": tienda,
                "ventas": ventas,
                "tickets": int(r["tickets"]),
                "clientes_unicos": int(r["clientes_unicos"]),
                "ticket_promedio": float(r["ticket_promedio"] or 0),
                "share_pct": share,
                "acumulado_pct": pct_acum,
                "var_pct": var,
                "location_ids": r["location_ids"],
                "complete_names": r["complete_names"] or [],
            })

        return {
            "items": items,
            "total_ventas": round(total_ventas, 2),
            "total_tiendas": len(items),
            "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
            "anio_compara": anio_compara,
        }
