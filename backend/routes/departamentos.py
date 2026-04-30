"""Ventas por departamento (res_partner.state_name)."""
from fastapi import APIRouter, Depends, Query
from typing import Optional

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, VENTA_REAL_WHERE, CLIENTE_SELECT,
    rango_vista, ytd_rango, row_to_dict,
)

router = APIRouter(prefix="/api")


@router.get("/departamentos/ventas")
async def deptos_ventas(
    vista: str = Query("ytd"),
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    anio_compara: Optional[int] = None,
    company_key: Optional[str] = None,
    location_id: Optional[int] = None,
    _user: dict = Depends(get_current_user),
):
    d, h = rango_vista(vista, desde, hasta)

    pool = await get_pool()
    async with pool.acquire() as conn:
        async def _agg(d_, h_):
            params: list = [d_, h_]
            where = ["v.date_order >= $1", "v.date_order <= $2", VENTA_REAL_WHERE]
            if company_key and company_key != "all":
                params.append(company_key)
                where.append(f"v.company_key = ${len(params)}")
            if location_id:
                params.append(location_id)
                where.append(f"po.location_id = ${len(params)}")
            sql = f"""
            WITH ord AS (
                SELECT DISTINCT v.order_id, po.amount_total,
                  {CLIENTE_SELECT} AS cliente_id
                {VENTA_REAL_FROM}
                WHERE {' AND '.join(where)}
            )
            SELECT
                COALESCE(NULLIF(UPPER(rp.state_name), ''), 'Sin definir') AS departamento,
                SUM(ord.amount_total)::numeric(14,2) AS ventas,
                COUNT(*) AS tickets,
                COUNT(DISTINCT ord.cliente_id) AS clientes_unicos
            FROM ord
            LEFT JOIN odoo.res_partner rp ON rp.odoo_id = ord.cliente_id
            GROUP BY 1
            ORDER BY ventas DESC;
            """
            rows = await conn.fetch(sql, *params)
            return {r["departamento"]: row_to_dict(r) for r in rows}

        actual = await _agg(d, h)
        anterior = {}
        if anio_compara and vista == "ytd":
            d_a, h_a = ytd_rango(anio_compara, h)
            anterior = await _agg(d_a, h_a)

        total_ventas = sum(float(r["ventas"]) for r in actual.values())

        items = []
        for depto, r in actual.items():
            ventas = float(r["ventas"])
            ant = anterior.get(depto)
            var = None
            if ant and float(ant["ventas"]) > 0:
                var = round((ventas - float(ant["ventas"])) / float(ant["ventas"]) * 100, 2)
            items.append({
                "departamento": depto.title() if depto != "Sin definir" else depto,
                "ventas": ventas,
                "tickets": int(r["tickets"]),
                "clientes_unicos": int(r["clientes_unicos"]),
                "share_pct": round(ventas / total_ventas * 100, 2) if total_ventas > 0 else 0,
                "var_pct": var,
            })

        return {
            "items": items,
            "total_ventas": round(total_ventas, 2),
            "agrupado_por": "departamento_cliente",
            "nota": "Solo captura clientes con state_name registrado en res_partner.",
            "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
            "anio_compara": anio_compara,
        }
