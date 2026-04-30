"""Export de ventas reales para análisis externo (Claude chat / Excel / etc).

Aplica TODOS los filtros del módulo Ventas:
- Venta real (no canceladas, no reservas)
- Palabras excluidas (correa, saco, tallero, etc.)
- Productos sin marca con purchase_ok=true
- Estado='excluido' en prod_odoo_productos_enriq
"""
import csv
import io
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, Query, Response
from auth_utils import get_current_user
from db import get_pool
from helpers import VENTA_REAL_FROM, VENTA_REAL_WHERE, CLIENTE_SELECT, parse_fecha

router = APIRouter(prefix="/api/export")


@router.get("/ventas-detalle")
async def export_ventas_detalle(
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    tienda: Optional[str] = None,
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    nivel: str = Query("linea", description="linea (cada producto) | ticket (cada orden)"),
    limit: int = Query(50000, le=200000),
    _u: dict = Depends(get_current_user),
):
    """Detalle por línea de ticket o por orden completa.

    nivel='linea': fecha, ticket, tienda, producto, marca, tipo, entalle, tela,
                   color, talla, qty, precio_unit, descuento, total_con_igv.
    nivel='ticket': fecha, ticket, tienda, cliente, vendedor, qty_total,
                    productos, total_con_igv (agrupado por orden).

    Fechas en hora Lima (UTC-5).
    """
    hoy = datetime.now()
    h_dt = parse_fecha(hasta) or datetime(hoy.year, hoy.month, hoy.day, 23, 59, 59)
    if h_dt.hour == 0:
        h_dt = h_dt.replace(hour=23, minute=59, second=59)
    d_dt = parse_fecha(desde) or (h_dt - timedelta(days=365))

    params: list = [d_dt, h_dt]
    where = ["v.date_order >= $1", "v.date_order <= $2", VENTA_REAL_WHERE]
    if tienda:
        params.append(tienda)
        where.append(f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ${len(params)})")
    if marca_id:
        params.append(marca_id)
        where.append(f"pe.marca_id = ${len(params)}")
    if tipo_id:
        params.append(tipo_id)
        where.append(f"pe.tipo_id = ${len(params)}")

    where_sql = " AND ".join(where)

    if nivel == "ticket":
        # Una fila por orden (igual al Excel oficial de Odoo POS)
        sql = f"""
        WITH lineas_filtradas AS (
            SELECT
                v.order_id, v.qty, v.price_subtotal,
                po.amount_total, po.date_order, po.tipo_comp, po.num_comp,
                po.x_pagos, po.partner_id, po.vendedor_id, po.location_id,
                po.state, po.company_key
            {VENTA_REAL_FROM}
            WHERE {where_sql}
        )
        SELECT
            -- Fecha en hora Lima
            (MIN(date_order) AT TIME ZONE 'America/Lima')::timestamp AS fecha,
            MAX(company_key) AS empresa,
            order_id AS ticket,
            MAX(tipo_comp) AS tipo_comprobante,
            MAX(num_comp) AS num_comprobante,
            MAX(sl.x_nombre) AS tienda,
            MAX(rp.name) AS cliente,
            MAX(uv.name) AS vendedor,
            MAX(x_pagos) AS pago,
            MAX(state) AS estado,
            SUM(qty)::numeric(14,2) AS qty_total,
            COUNT(*) AS lineas,
            MAX(amount_total)::numeric(14,2) AS total_con_igv
        FROM lineas_filtradas lf
        LEFT JOIN odoo.stock_location sl ON sl.odoo_id = lf.location_id
        LEFT JOIN odoo.res_partner rp ON rp.odoo_id = lf.partner_id
        LEFT JOIN odoo.res_users uv ON uv.odoo_id = lf.vendedor_id
        GROUP BY order_id
        ORDER BY MIN(date_order) DESC
        LIMIT {limit};
        """
        headers = ["fecha", "empresa", "ticket", "tipo_comprobante", "num_comprobante", "tienda",
                   "cliente", "vendedor", "pago", "estado", "qty_total", "lineas", "total_con_igv"]
    else:
        # Una fila por línea de ticket (cada producto vendido)
        sql = f"""
        SELECT
            -- Fecha y hora en zona Lima
            (v.date_order AT TIME ZONE 'America/Lima')::timestamp AS fecha,
            v.order_id AS ticket,
            sl.x_nombre AS tienda,
            pt.name AS producto,
            COALESCE(ma.nombre, ma_auto.nombre, pt.marca) AS marca,
            COALESCE(ti.nombre, ti_auto.nombre, pt.tipo) AS tipo,
            COALESCE(en.nombre, en_auto.nombre, pt.entalle) AS entalle,
            COALESCE(te.nombre, te_auto.nombre, pt.tela) AS tela,
            v.color,
            v.talla,
            v.qty,
            v.price_unit::numeric(10,2) AS precio_unit,
            v.discount AS descuento_pct,
            (v.price_subtotal * 1.18)::numeric(12,2) AS total_con_igv
        {VENTA_REAL_FROM}
        LEFT JOIN odoo.product_template pt ON pt.odoo_id = v.product_tmpl_id
        LEFT JOIN odoo.stock_location sl ON sl.odoo_id = po.location_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id
        LEFT JOIN produccion.prod_marcas ma ON ma.id = pe.marca_id
        LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
        LEFT JOIN produccion.prod_entalles en ON en.id = pe.entalle_id
        LEFT JOIN produccion.prod_telas te ON te.id = pe.tela_id
        LEFT JOIN produccion.prod_marcas ma_auto
            ON pe.marca_id IS NULL AND pt.marca <> ''
            AND LOWER(TRIM(ma_auto.nombre)) = LOWER(TRIM(pt.marca))
        LEFT JOIN produccion.prod_tipos ti_auto
            ON pe.tipo_id IS NULL AND pt.tipo <> ''
            AND LOWER(TRIM(ti_auto.nombre)) = LOWER(TRIM(SPLIT_PART(pt.tipo, ' ', 1)))
        LEFT JOIN produccion.prod_entalles en_auto
            ON pe.entalle_id IS NULL AND pt.entalle <> ''
            AND LOWER(TRIM(en_auto.nombre)) = LOWER(TRIM(pt.entalle))
        LEFT JOIN produccion.prod_telas te_auto
            ON pe.tela_id IS NULL AND pt.tela <> ''
            AND LOWER(TRIM(te_auto.nombre)) = LOWER(TRIM(pt.tela))
        WHERE {where_sql}
        ORDER BY v.date_order DESC
        LIMIT {limit};
        """
        headers = ["fecha", "ticket", "tienda", "producto", "marca", "tipo", "entalle", "tela",
                   "color", "talla", "qty", "precio_unit", "descuento_pct", "total_con_igv"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for r in rows:
        d = dict(r)
        row = []
        for h in headers:
            v = d.get(h)
            if v is None:
                row.append("")
            elif hasattr(v, 'isoformat'):
                row.append(v.isoformat())
            else:
                row.append(str(v))
        writer.writerow(row)

    csv_text = buf.getvalue()
    filename = f"ventas-detalle-{d_dt.date().isoformat()}-a-{h_dt.date().isoformat()}.csv"
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Filas": str(len(rows)),
            "X-Limite-Aplicado": str(limit),
        },
    )


@router.get("/ventas")
async def export_ventas(
    agrupacion: str = Query("mes_marca_tipo", description="mes|mes_marca|mes_marca_tipo|mes_grupo|dia"),
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    tienda: Optional[str] = None,
    company_key: Optional[str] = None,
    _u: dict = Depends(get_current_user),
):
    """Genera CSV de ventas YTD agrupado según la granularidad pedida.

    Granularidades:
      mes              → 1 fila por mes (totales)
      mes_marca        → 1 fila por (mes, marca)
      mes_marca_tipo   → 1 fila por (mes, marca, tipo)
      mes_grupo        → 1 fila por (mes, marca, tipo, entalle, tela) — más detalle
      dia              → 1 fila por día (serie temporal limpia)
    """
    # Rango por defecto: 24 meses hasta hoy
    hoy = datetime.now()
    h_dt = parse_fecha(hasta) or datetime(hoy.year, hoy.month, hoy.day, 23, 59, 59)
    if h_dt.hour == 0:
        h_dt = h_dt.replace(hour=23, minute=59, second=59)
    d_dt = parse_fecha(desde) or (h_dt - timedelta(days=730))  # ~24 meses

    # WHERE construction
    params: list = [d_dt, h_dt]
    where = ["v.date_order >= $1", "v.date_order <= $2", VENTA_REAL_WHERE]
    if company_key and company_key != "all":
        params.append(company_key)
        where.append(f"v.company_key = ${len(params)}")
    if tienda:
        params.append(tienda)
        where.append(f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ${len(params)})")

    where_sql = " AND ".join(where)

    # Definir GROUP BY y SELECT según agrupación
    if agrupacion == "dia":
        select_extra = "DATE(v.date_order AT TIME ZONE 'America/Lima') AS dia"
        group_by = "DATE(v.date_order AT TIME ZONE 'America/Lima')"
        order_by = "1"
        headers = ["dia", "ventas", "unidades", "tickets", "clientes_unicos"]
    elif agrupacion == "mes":
        select_extra = "TO_CHAR(v.date_order AT TIME ZONE 'America/Lima', 'YYYY-MM') AS mes"
        group_by = "TO_CHAR(v.date_order AT TIME ZONE 'America/Lima', 'YYYY-MM')"
        order_by = "1"
        headers = ["mes", "ventas", "unidades", "tickets", "clientes_unicos"]
    elif agrupacion == "mes_marca":
        select_extra = """
            TO_CHAR(v.date_order AT TIME ZONE 'America/Lima', 'YYYY-MM') AS mes,
            COALESCE(ma.nombre, ma_auto.nombre, pt.marca, 'Sin marca') AS marca
        """
        group_by = "1, 2"
        order_by = "1, ventas DESC"
        headers = ["mes", "marca", "ventas", "unidades", "tickets", "clientes_unicos"]
    elif agrupacion == "mes_marca_tipo":
        select_extra = """
            TO_CHAR(v.date_order AT TIME ZONE 'America/Lima', 'YYYY-MM') AS mes,
            COALESCE(ma.nombre, ma_auto.nombre, pt.marca, 'Sin marca') AS marca,
            COALESCE(ti.nombre, ti_auto.nombre, pt.tipo, 'Sin tipo') AS tipo
        """
        group_by = "1, 2, 3"
        order_by = "1, ventas DESC"
        headers = ["mes", "marca", "tipo", "ventas", "unidades", "tickets", "clientes_unicos"]
    else:  # mes_grupo
        select_extra = """
            TO_CHAR(v.date_order AT TIME ZONE 'America/Lima', 'YYYY-MM') AS mes,
            COALESCE(ma.nombre, ma_auto.nombre, pt.marca, 'Sin marca') AS marca,
            COALESCE(ti.nombre, ti_auto.nombre, pt.tipo, 'Sin tipo') AS tipo,
            COALESCE(en.nombre, en_auto.nombre, pt.entalle, 'Sin entalle') AS entalle,
            COALESCE(te.nombre, te_auto.nombre, pt.tela, 'Sin tela') AS tela
        """
        group_by = "1, 2, 3, 4, 5"
        order_by = "1, ventas DESC"
        headers = ["mes", "marca", "tipo", "entalle", "tela", "ventas", "unidades", "tickets", "clientes_unicos"]

    # Joins necesarios solo si la agrupación los requiere
    needs_joins = agrupacion not in ("mes", "dia")
    extra_joins = ""
    if needs_joins:
        extra_joins = f"""
        LEFT JOIN odoo.product_template pt ON pt.odoo_id = v.product_tmpl_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id
        LEFT JOIN produccion.prod_marcas ma ON ma.id = pe.marca_id
        LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
        LEFT JOIN produccion.prod_entalles en ON en.id = pe.entalle_id
        LEFT JOIN produccion.prod_telas te ON te.id = pe.tela_id
        LEFT JOIN produccion.prod_marcas ma_auto
            ON pe.marca_id IS NULL AND pt.marca <> ''
            AND LOWER(TRIM(ma_auto.nombre)) = LOWER(TRIM(pt.marca))
        LEFT JOIN produccion.prod_tipos ti_auto
            ON pe.tipo_id IS NULL AND pt.tipo <> ''
            AND LOWER(TRIM(ti_auto.nombre)) = LOWER(TRIM(SPLIT_PART(pt.tipo, ' ', 1)))
        LEFT JOIN produccion.prod_entalles en_auto
            ON pe.entalle_id IS NULL AND pt.entalle <> ''
            AND LOWER(TRIM(en_auto.nombre)) = LOWER(TRIM(pt.entalle))
        LEFT JOIN produccion.prod_telas te_auto
            ON pe.tela_id IS NULL AND pt.tela <> ''
            AND LOWER(TRIM(te_auto.nombre)) = LOWER(TRIM(pt.tela))
        """

    sql = f"""
    SELECT
        {select_extra},
        SUM(v.price_subtotal * 1.18)::numeric(14,2) AS ventas,
        SUM(v.qty)::numeric(14,2) AS unidades,
        COUNT(DISTINCT v.order_id) AS tickets,
        COUNT(DISTINCT {CLIENTE_SELECT}) AS clientes_unicos
    {VENTA_REAL_FROM}
    {extra_joins}
    WHERE {where_sql}
    GROUP BY {group_by}
    ORDER BY {order_by};
    """

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    # Generar CSV
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for r in rows:
        d = dict(r)
        row = []
        for h in headers:
            v = d.get(h)
            if v is None:
                row.append("")
            elif hasattr(v, 'isoformat'):
                row.append(v.isoformat())
            else:
                row.append(str(v))
        writer.writerow(row)

    csv_text = buf.getvalue()
    filename = f"ventas-{agrupacion}-{d_dt.date().isoformat()}-a-{h_dt.date().isoformat()}.csv"

    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Filas": str(len(rows)),
            "X-Filtros-Aplicados": "venta_real,palabras_excluidas,estado_excluido,purchase_ok_sin_marca",
        },
    )
