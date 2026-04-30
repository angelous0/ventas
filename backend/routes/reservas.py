"""Reservas pendientes: órdenes marcadas como reserva, no canceladas, no usadas aún."""
from fastapi import APIRouter, Depends, Query
from typing import Optional

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, RESERVA_PENDIENTE_WHERE, CLIENTE_SELECT, row_to_dict,
)

router = APIRouter(prefix="/api")


@router.get("/reservas/pendientes")
async def reservas_pendientes(
    limit: int = Query(200, ge=1, le=1000),
    _user: dict = Depends(get_current_user),
):
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Una fila por orden de reserva + array de productos.
        # Campos extra:
        #   - tipo_comp / num_comp: para mostrar el comprobante (ej. "BE B003-18352")
        #   - vendedor_id → res_users.name (quién atendió). Si la orden no tiene
        #     vendedor asignado (~65% de las reservas), caemos a user_id (cajero).
        sql = f"""
        WITH base AS (
            SELECT
                v.order_id,
                v.date_order,
                po.amount_total,
                {CLIENTE_SELECT} AS cliente_id,
                po.location_id,
                po.tipo_comp,
                po.num_comp,
                po.vendedor_id,
                po.user_id,
                v.product_tmpl_id,
                v.color,
                v.talla,
                v.qty,
                v.price_subtotal
            {VENTA_REAL_FROM}
            WHERE {RESERVA_PENDIENTE_WHERE}
        ),
        por_orden AS (
            SELECT DISTINCT order_id, date_order, amount_total, cliente_id, location_id,
                            tipo_comp, num_comp, vendedor_id, user_id
            FROM base
        )
        SELECT
            po_.order_id,
            po_.date_order,
            po_.amount_total::numeric(14,2) AS monto,
            po_.cliente_id,
            rp.name AS cliente_nombre,
            rp.phone AS cliente_phone,
            po_.location_id,
            sl.x_nombre AS tienda,
            po_.tipo_comp,
            po_.num_comp,
            po_.vendedor_id,
            po_.user_id,
            -- Nombre a mostrar: vendedor si existe, sino el cajero (user_id)
            COALESCE(uv_vend.name, uv_caj.name) AS vendedor_nombre,
            -- Marca si el nombre vino del campo "vendedor" o del "cajero" (user_id)
            CASE
                WHEN uv_vend.name IS NOT NULL THEN 'vendedor'
                WHEN uv_caj.name  IS NOT NULL THEN 'cajero'
                ELSE NULL
            END AS vendedor_origen,
            EXTRACT(DAY FROM (NOW() - po_.date_order))::int AS dias_reserva,
            (SELECT COUNT(*) FROM base b WHERE b.order_id = po_.order_id) AS lineas,
            (SELECT SUM(b.qty) FROM base b WHERE b.order_id = po_.order_id) AS unidades
        FROM por_orden po_
        LEFT JOIN odoo.res_partner rp ON rp.odoo_id = po_.cliente_id
        LEFT JOIN odoo.stock_location sl ON sl.odoo_id = po_.location_id
        LEFT JOIN odoo.res_users uv_vend ON uv_vend.odoo_id = po_.vendedor_id
        LEFT JOIN odoo.res_users uv_caj  ON uv_caj.odoo_id  = po_.user_id
        ORDER BY po_.date_order DESC
        LIMIT $1;
        """
        rows = await conn.fetch(sql, limit)
        items = [row_to_dict(r) for r in rows]

        total_monto = sum(float(it["monto"] or 0) for it in items)
        return {
            "items": items,
            "total": len(items),
            "monto_total": round(total_monto, 2),
        }
