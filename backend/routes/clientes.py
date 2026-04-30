"""Análisis de clientes: top por ventas, frecuencia, días sin comprar, primeros/últimos."""
from fastapi import APIRouter, Depends, Query
from typing import Optional
from datetime import datetime

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, VENTA_REAL_WHERE, CLIENTE_SELECT,
    rango_vista, row_to_dict,
)

router = APIRouter(prefix="/api")


@router.get("/clientes/top")
async def clientes_top(
    vista: str = Query("ytd"),
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    orden: str = Query("ventas", description="ventas|tickets|ticket_promedio|frecuencia|dias_sin_comprar"),
    company_key: Optional[str] = None,
    location_id: Optional[int] = None,
    _user: dict = Depends(get_current_user),
):
    d, h = rango_vista(vista, desde, hasta)

    pool = await get_pool()
    async with pool.acquire() as conn:
        base_filter = [
            "v.date_order >= $1",
            "v.date_order <= $2",
            VENTA_REAL_WHERE,
            f"{CLIENTE_SELECT} IS NOT NULL",
        ]
        params: list = [d, h]
        if company_key and company_key != "all":
            params.append(company_key)
            base_filter.append(f"v.company_key = ${len(params)}")
        if location_id:
            params.append(location_id)
            base_filter.append(f"po.location_id = ${len(params)}")

        where_sql = " AND ".join(base_filter)

        # Métricas por cliente en el período. Frecuencia = días/tickets promedio.
        sql = f"""
        WITH por_cliente AS (
            SELECT
                {CLIENTE_SELECT} AS cliente_id,
                CASE WHEN po.x_cliente_principal IS NOT NULL THEN 'principal' ELSE 'cuenta_partner' END AS tipo,
                v.order_id,
                v.date_order,
                po.amount_total
            {VENTA_REAL_FROM}
            WHERE {where_sql}
        ),
        ordenes AS (
            SELECT DISTINCT cliente_id, tipo, order_id, date_order, amount_total
            FROM por_cliente
        ),
        agg AS (
            SELECT
                cliente_id,
                MIN(tipo) AS tipo,
                SUM(amount_total)::numeric(14,2) AS ventas,
                COUNT(*) AS tickets,
                MIN(date_order) AS primera_compra,
                MAX(date_order) AS ultima_compra
            FROM ordenes
            GROUP BY cliente_id
        ),
        unidades AS (
            SELECT cliente_id, SUM(qty) AS unidades
            FROM (
                SELECT {CLIENTE_SELECT} AS cliente_id, v.qty
                {VENTA_REAL_FROM}
                WHERE {where_sql}
            ) x GROUP BY cliente_id
        )
        SELECT
            a.cliente_id,
            a.tipo,
            rp.name AS nombre,
            rp.phone,
            rp.mobile,
            rp.city,
            rp.state_name,
            a.ventas,
            a.tickets,
            u.unidades::numeric(14,2) AS unidades,
            (a.ventas / NULLIF(a.tickets, 0))::numeric(14,2) AS ticket_promedio,
            a.primera_compra,
            a.ultima_compra,
            EXTRACT(DAY FROM (a.ultima_compra - a.primera_compra))::int AS rango_dias,
            CASE WHEN a.tickets > 1 THEN
                (EXTRACT(EPOCH FROM (a.ultima_compra - a.primera_compra)) / 86400 / NULLIF(a.tickets - 1, 0))::numeric(10,1)
            ELSE NULL END AS frecuencia_dias,
            EXTRACT(DAY FROM (NOW() - a.ultima_compra))::int AS dias_sin_comprar
        FROM agg a
        LEFT JOIN odoo.res_partner rp ON rp.odoo_id = a.cliente_id
        LEFT JOIN unidades u ON u.cliente_id = a.cliente_id
        """

        # Orden
        if orden == "tickets":
            sql += " ORDER BY a.tickets DESC"
        elif orden == "ticket_promedio":
            sql += " ORDER BY (a.ventas / NULLIF(a.tickets, 0)) DESC NULLS LAST"
        elif orden == "frecuencia":
            sql += " ORDER BY frecuencia_dias ASC NULLS LAST"
        elif orden == "dias_sin_comprar":
            sql += " ORDER BY a.ultima_compra ASC"
        else:
            sql += " ORDER BY a.ventas DESC"

        sql += " LIMIT $" + str(len(params) + 1) + " OFFSET $" + str(len(params) + 2)
        params.extend([limit, offset])

        rows = await conn.fetch(sql, *params)

        return {
            "items": [row_to_dict(r) for r in rows],
            "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
            "total": len(rows),
        }
