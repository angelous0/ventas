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
from typing import Optional, List
from fastapi import APIRouter, Depends, Query, Response
from auth_utils import get_current_user
from db import get_pool
from helpers import VENTA_REAL_FROM, VENTA_REAL_WHERE, CLIENTE_SELECT, parse_fecha

router = APIRouter(prefix="/api/export")


def _split_csv(s: Optional[str]) -> List[str]:
    """Convierte 'a,b,c' → ['a','b','c'] descartando vacíos."""
    if not s:
        return []
    return [x.strip() for x in s.split(",") if x.strip()]


def _add_jerarquia_filters(where_parts: list, params: list,
                           marcas: Optional[str] = None,
                           tipos: Optional[str] = None,
                           entalles: Optional[str] = None,
                           telas: Optional[str] = None,
                           usa_pe_alias: bool = True):
    """Añade al WHERE filtros multi-valor de marca/tipo/entalle/tela.

    Acepta CSV de UUIDs del catálogo (no nombres). Filtra por pe.<dim>_id
    cuando hay FK; queda implícito que SKUs sin clasificar no pasarán este
    filtro (decisión consciente).

    Si `usa_pe_alias=True` el filtro es directo sobre `pe.<col>`. Si no,
    se asume que el caller ya hizo el LEFT JOIN bajo otro alias (no usado
    actualmente).
    """
    pref = "pe."
    for csv_str, col in [(marcas, "marca_id"), (tipos, "tipo_id"),
                         (entalles, "entalle_id"), (telas, "tela_id")]:
        ids = _split_csv(csv_str)
        if ids:
            params.append(ids)
            where_parts.append(f"{pref}{col} = ANY(${len(params)}::text[])")


@router.get("/ventas-detalle")
async def export_ventas_detalle(
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    tienda: Optional[str] = None,
    # Filtros legacy (single-id) — mantengo por compat, se mergean a los CSV.
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    # Filtros multi (CSV de UUIDs del catálogo). Tienen prioridad.
    marcas: Optional[str] = Query(None, description="UUIDs de marca, coma-separados"),
    tipos: Optional[str] = Query(None, description="UUIDs de tipo, coma-separados"),
    entalles: Optional[str] = Query(None, description="UUIDs de entalle, coma-separados"),
    telas: Optional[str] = Query(None, description="UUIDs de tela, coma-separados"),
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

    # Mergear params legacy single → multi CSV
    if marca_id and not marcas:
        marcas = marca_id
    if tipo_id and not tipos:
        tipos = tipo_id

    params: list = [d_dt, h_dt]
    where = ["v.date_order >= $1", "v.date_order <= $2", VENTA_REAL_WHERE]
    if tienda:
        params.append(tienda)
        where.append(f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ${len(params)})")
    # Filtros de jerarquía (marca/tipo/entalle/tela). Asume LEFT JOIN con
    # produccion.prod_odoo_productos_enriq pe que ya está en ambas queries.
    _add_jerarquia_filters(where, params, marcas, tipos, entalles, telas)

    where_sql = " AND ".join(where)

    if nivel == "ticket":
        # Una fila por orden (igual al Excel oficial de Odoo POS).
        # El LEFT JOIN con prod_odoo_productos_enriq es necesario aún en el
        # nivel ticket porque permite filtrar por marca/tipo/entalle/tela
        # (los filtros de jerarquía operan a nivel línea aunque agreguemos
        # por orden — una orden con CUALQUIER línea matching aparece).
        # IMPORTANTE: las 4 tablas que se LEFT JOINean abajo (stock_location,
        # res_partner, res_users) y la CTE `lf` (vía pos_order) tienen TODAS
        # una columna `company_key`. Por eso prefijamos todas las columnas
        # del SELECT con `lf.` para evitar AmbiguousColumnError. Los alias sl/
        # rp/uv ya estaban prefijados (x_nombre, name).
        sql = f"""
        WITH lineas_filtradas AS (
            SELECT
                v.order_id, v.qty, v.price_subtotal,
                po.amount_total, po.date_order, po.tipo_comp, po.num_comp,
                po.x_pagos, po.partner_id, po.vendedor_id, po.location_id,
                po.state, po.company_key
            {VENTA_REAL_FROM}
            LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id
            WHERE {where_sql}
        )
        SELECT
            -- Fecha en hora Lima
            (MIN(lf.date_order) AT TIME ZONE 'America/Lima')::timestamp AS fecha,
            MAX(lf.company_key) AS empresa,
            lf.order_id AS ticket,
            MAX(lf.tipo_comp) AS tipo_comprobante,
            MAX(lf.num_comp) AS num_comprobante,
            MAX(sl.x_nombre) AS tienda,
            MAX(rp.name) AS cliente,
            MAX(uv.name) AS vendedor,
            MAX(lf.x_pagos) AS pago,
            MAX(lf.state) AS estado,
            SUM(lf.qty)::numeric(14,2) AS qty_total,
            COUNT(*) AS lineas,
            MAX(lf.amount_total)::numeric(14,2) AS total_con_igv
        FROM lineas_filtradas lf
        LEFT JOIN odoo.stock_location sl ON sl.odoo_id = lf.location_id
        LEFT JOIN odoo.res_partner rp ON rp.odoo_id = lf.partner_id
        LEFT JOIN odoo.res_users uv ON uv.odoo_id = lf.vendedor_id
        GROUP BY lf.order_id
        ORDER BY MIN(lf.date_order) DESC
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
    # Filtros multi de jerarquía (CSV de UUIDs del catálogo)
    marcas: Optional[str] = Query(None, description="UUIDs de marca, coma-separados"),
    tipos: Optional[str] = Query(None, description="UUIDs de tipo, coma-separados"),
    entalles: Optional[str] = Query(None, description="UUIDs de entalle, coma-separados"),
    telas: Optional[str] = Query(None, description="UUIDs de tela, coma-separados"),
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

    # Filtros multi de marca/tipo/entalle/tela. Si se piden, hay que asegurar
    # que el JOIN con prod_odoo_productos_enriq esté presente (lo agregamos
    # más abajo en `extra_joins` cuando needs_joins=True; si los filtros se
    # piden con agrupación 'mes' o 'dia' que no joinea, lo forzamos).
    _add_jerarquia_filters(where, params, marcas, tipos, entalles, telas)
    needs_pe_join = bool(marcas or tipos or entalles or telas)

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

    # Joins necesarios solo si la agrupación los requiere O si hay filtro
    # de marca/tipo/entalle/tela aplicado (necesitan pe.* en el WHERE).
    needs_joins = agrupacion not in ("mes", "dia") or needs_pe_join
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


# ============================================================
# Stock detalle a CSV
# ============================================================
@router.get("/stock-detalle")
async def export_stock_detalle(
    nivel: str = Query("detalle", description="detalle (modelo×color×talla×tienda) | grupo (marca·tipo·entalle·tela × tienda)"),
    tiendas: Optional[str] = Query(None, description="x_nombre coma-separados. Vacío = todas las tiendas internas activas"),
    marcas: Optional[str] = Query(None, description="UUIDs de marca coma-separados"),
    tipos: Optional[str] = Query(None, description="UUIDs de tipo coma-separados"),
    entalles: Optional[str] = Query(None, description="UUIDs de entalle coma-separados"),
    telas: Optional[str] = Query(None, description="UUIDs de tela coma-separados"),
    incluir_almacenes: bool = Query(True, description="Si false, excluye TALLER, AP, REMATE, ZAP (solo comerciales)"),
    min_stock: int = Query(1, ge=0, description="Filtrar SKUs/grupos con stock >= N. Default 1 (excluye stock 0)"),
    limit: int = Query(100000, le=500000),
    _u: dict = Depends(get_current_user),
):
    """Stock actual a CSV con todos los filtros del módulo aplicados.

    Niveles disponibles:

    - **detalle**: una fila por (modelo, color, talla, tienda). Máxima
      granularidad. Columnas: marca, tipo, entalle, tela, modelo, color,
      talla, tienda, stock.
      Volumen típico: ~30-100K filas sin filtros.

    - **grupo**: una fila por (marca, tipo, entalle, tela, tienda).
      Agregación a nivel grupo lógico. Columnas: marca, tipo, entalle,
      tela, tienda, modelos, skus, stock.
      Volumen típico: ~1-2K filas.

    Filtros aplicados:
    - sl.usage = 'internal' AND sl.active = true (defensivo)
    - pp.active = true AND pt.active = true (variantes/templates vivos)
    - q.qty > 0 (sólo locations con stock real)
    - PRODUCTO_VALIDO_STOCK_WHERE: excluye correa/bolsa/saco/tallero, etc.
    """
    # Filtros de jerarquía → cláusulas extra del WHERE
    params: list = []
    where_extra = []

    tiendas_list = _split_csv(tiendas)
    if tiendas_list:
        params.append(tiendas_list)
        where_extra.append(f"sl.x_nombre = ANY(${len(params)}::text[])")

    if not incluir_almacenes:
        # Excluir locations que son almacenes/depósitos (no tiendas comerciales)
        where_extra.append("sl.x_nombre NOT IN ('TALLER', 'AP', 'REMATE', 'ZAP', 'Fallados Qepo')")

    for csv_str, col in [(marcas, "marca_id"), (tipos, "tipo_id"),
                         (entalles, "entalle_id"), (telas, "tela_id")]:
        ids = _split_csv(csv_str)
        if ids:
            params.append(ids)
            where_extra.append(f"pe.{col} = ANY(${len(params)}::text[])")

    where_jerarquia = (" AND " + " AND ".join(where_extra)) if where_extra else ""

    # Patrones de productos prohibidos. Reuso PALABRAS_EXCLUIDAS de helpers.
    from helpers import PALABRAS_EXCLUIDAS
    patterns_sql = ",".join(f"'%{p}%'" for p in PALABRAS_EXCLUIDAS)
    PRODUCTO_VALIDO = f"""
    pt.odoo_id NOT IN (
        SELECT odoo_id FROM odoo.product_template
        WHERE name ILIKE ANY (ARRAY[{patterns_sql}])
           OR (purchase_ok = true AND (marca IS NULL OR marca = ''))
    )
    AND NOT EXISTS (
        SELECT 1 FROM produccion.prod_odoo_productos_enriq pe_excl
        WHERE pe_excl.odoo_template_id = pt.odoo_id AND pe_excl.estado = 'excluido'
    )
    """.strip()

    # Auto-match con catálogo (mismo patrón que /reposicion)
    AUTO_MATCH_JOINS = """
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

    if nivel == "grupo":
        params.append(min_stock)
        idx_min = len(params)
        sql = f"""
        SELECT
            COALESCE(ma.nombre, ma_auto.nombre, NULLIF(pt.marca, ''), '— sin marca —') AS marca,
            COALESCE(ti.nombre, ti_auto.nombre, NULLIF(pt.tipo, ''), '— sin tipo —')   AS tipo,
            COALESCE(en.nombre, en_auto.nombre, NULLIF(pt.entalle, ''), '— sin entalle —') AS entalle,
            COALESCE(te.nombre, te_auto.nombre, NULLIF(pt.tela, ''), '— sin tela —')   AS tela,
            sl.x_nombre AS tienda,
            COUNT(DISTINCT pt.odoo_id) AS modelos,
            COUNT(DISTINCT pp.odoo_id) AS skus,
            SUM(q.qty)::int AS stock
        FROM odoo.stock_quant q
        JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
        JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
        JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        {AUTO_MATCH_JOINS}
        WHERE q.qty > 0
          AND sl.usage = 'internal' AND sl.active = true
          AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
          AND {PRODUCTO_VALIDO}
          {where_jerarquia}
        GROUP BY 1, 2, 3, 4, 5
        HAVING SUM(q.qty) >= ${idx_min}
        ORDER BY stock DESC
        LIMIT {limit};
        """
        headers = ["marca", "tipo", "entalle", "tela", "tienda", "modelos", "skus", "stock"]
    else:  # detalle
        params.append(min_stock)
        idx_min = len(params)
        sql = f"""
        SELECT
            COALESCE(ma.nombre, ma_auto.nombre, NULLIF(pt.marca, ''), '— sin marca —') AS marca,
            COALESCE(ti.nombre, ti_auto.nombre, NULLIF(pt.tipo, ''), '— sin tipo —')   AS tipo,
            COALESCE(en.nombre, en_auto.nombre, NULLIF(pt.entalle, ''), '— sin entalle —') AS entalle,
            COALESCE(te.nombre, te_auto.nombre, NULLIF(pt.tela, ''), '— sin tela —')   AS tela,
            pt.name AS modelo,
            COALESCE(NULLIF(vf.color, ''), '— sin color —') AS color,
            COALESCE(NULLIF(vf.talla, ''), '—') AS talla,
            sl.x_nombre AS tienda,
            SUM(q.qty)::int AS stock
        FROM odoo.stock_quant q
        JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
        JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
        JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
        JOIN odoo.v_product_variant_flat vf ON vf.product_product_id = pp.odoo_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        {AUTO_MATCH_JOINS}
        WHERE q.qty > 0
          AND sl.usage = 'internal' AND sl.active = true
          AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
          AND {PRODUCTO_VALIDO}
          {where_jerarquia}
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
        HAVING SUM(q.qty) >= ${idx_min}
        ORDER BY marca, tipo, entalle, tela, modelo, color, talla, tienda
        LIMIT {limit};
        """
        headers = ["marca", "tipo", "entalle", "tela", "modelo", "color", "talla", "tienda", "stock"]

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
    today_iso = datetime.now().date().isoformat()
    filename = f"stock-{nivel}-{today_iso}.csv"

    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Filas": str(len(rows)),
            "X-Nivel": nivel,
            "X-Limite-Aplicado": str(limit),
        },
    )
