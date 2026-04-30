"""Ranking de productos + análisis crecen/caen.

GET /api/productos/ranking — tabla con métricas + variación vs año anterior
GET /api/productos/crecen-caen — top N que crecen y top N que caen

Se agrega por product_tmpl_id (template), que unifica todas las variantes.
Stock desde odoo.v_stock_by_product (agrupado por product_id → product_tmpl_id).
Clasificación manual priorizada (prod_odoo_productos_enriq), fallback a texto.
"""
from fastapi import APIRouter, Depends, Query
from typing import Optional, List
from datetime import datetime

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, VENTA_REAL_WHERE,
    rango_vista, ytd_rango, row_to_dict,
)

router = APIRouter(prefix="/api")


def _build_ranking_sql(where_venta: str, params_count: int) -> str:
    """Query base de ranking: un row por product_tmpl_id con métricas agregadas.

    Toma `where_venta` ya construido (incluye filtro de fecha + VENTA_REAL + opcionales).
    Retorna una CTE reusable que puede joinearse con stock/costo/clasificación.
    """
    return f"""
    SELECT
        v.product_tmpl_id,
        COALESCE(SUM(v.price_subtotal * 1.18), 0)::numeric(14,2) AS ventas,
        COALESCE(SUM(v.qty), 0)::numeric(14,2) AS unidades,
        COUNT(DISTINCT v.order_id) AS tickets,
        COALESCE(SUM(v.price_subtotal), 0)::numeric(14,2) AS ventas_sin_igv
    {VENTA_REAL_FROM}
    WHERE {where_venta}
    GROUP BY v.product_tmpl_id
    """


def _where_venta(d: datetime, h: datetime, params: list,
                 company_key: Optional[str], location_id: Optional[int]) -> str:
    """Añade filtro de fecha + venta real + opcionales, y muta `params` in-place."""
    parts = ["v.date_order >= $1", "v.date_order <= $2", VENTA_REAL_WHERE]
    params.append(d)
    params.append(h)
    if company_key and company_key != "all":
        params.append(company_key)
        parts.append(f"v.company_key = ${len(params)}")
    if location_id:
        params.append(location_id)
        parts.append(f"po.location_id = ${len(params)}")
    return " AND ".join(parts)


async def _ranking_base(conn, d: datetime, h: datetime,
                        company_key: Optional[str], location_id: Optional[int]) -> dict:
    """Devuelve {product_tmpl_id: {ventas, unidades, tickets, ventas_sin_igv}}."""
    params: list = []
    where = _where_venta(d, h, params, company_key, location_id)
    sql = _build_ranking_sql(where, len(params))
    rows = await conn.fetch(sql, *params)
    return {r["product_tmpl_id"]: dict(r) for r in rows}


@router.get("/productos/ranking")
async def ranking(
    vista: str = Query("ytd"),
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    anio_compara: Optional[int] = Query(None, description="año comparativo YTD same-day"),
    company_key: Optional[str] = None,
    location_id: Optional[int] = None,
    orden: str = Query("ventas", description="ventas|unidades|tickets|margen"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    d, h = rango_vista(vista, desde, hasta)

    pool = await get_pool()
    async with pool.acquire() as conn:
        # 1. Ventas del período actual
        data_actual = await _ranking_base(conn, d, h, company_key, location_id)

        # 2. Ventas del período comparativo (si aplica)
        data_ant = {}
        if anio_compara and vista == "ytd":
            d_a, h_a = ytd_rango(anio_compara, h)
            data_ant = await _ranking_base(conn, d_a, h_a, company_key, location_id)

        if not data_actual:
            return {"items": [], "total": 0, "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()}}

        # 3. Enriquecer: nombre, SKU, clasificación, stock, costo
        tmpl_ids = list(data_actual.keys())
        filters = ["pt.odoo_id = ANY($1)"]
        enriq_params: list = [tmpl_ids]
        if marca_id:
            enriq_params.append(marca_id)
            filters.append(f"pe.marca_id = ${len(enriq_params)}")
        if tipo_id:
            enriq_params.append(tipo_id)
            filters.append(f"pe.tipo_id = ${len(enriq_params)}")
        where_enriq = " AND ".join(filters)

        # Stock por template: sumar variantes
        sql_enriq = f"""
        WITH stock_por_tmpl AS (
            SELECT pp.product_tmpl_id, SUM(vs.qty)::numeric(14,2) AS stock
            FROM odoo.v_stock_by_product vs
            LEFT JOIN odoo.product_product pp ON pp.odoo_id = vs.product_id
            WHERE pp.product_tmpl_id = ANY($1)
            GROUP BY pp.product_tmpl_id
        )
        SELECT
            pt.odoo_id AS product_tmpl_id,
            pt.name AS nombre,
            pe.marca_id, pe.tipo_id, pe.entalle_id, pe.tela_id,
            pe.costo_manual,
            m.nombre AS marca_nombre,
            ti.nombre AS tipo_nombre,
            en.nombre AS entalle_nombre,
            te.nombre AS tela_nombre,
            st.stock
        FROM odoo.product_template pt
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        LEFT JOIN produccion.prod_marcas m ON m.id = pe.marca_id
        LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
        LEFT JOIN produccion.prod_entalles en ON en.id = pe.entalle_id
        LEFT JOIN produccion.prod_telas te ON te.id = pe.tela_id
        LEFT JOIN stock_por_tmpl st ON st.product_tmpl_id = pt.odoo_id
        WHERE {where_enriq};
        """
        enriq_rows = await conn.fetch(sql_enriq, *enriq_params)
        enriq_by_tmpl = {r["product_tmpl_id"]: dict(r) for r in enriq_rows}

        # 4. Armar items
        items = []
        for tmpl_id, venta_data in data_actual.items():
            if tmpl_id not in enriq_by_tmpl:
                # Filtros de clasificación descartaron este producto
                continue
            enriq = enriq_by_tmpl[tmpl_id]
            ventas = float(venta_data["ventas"])
            unidades = float(venta_data["unidades"])
            ventas_sin_igv = float(venta_data["ventas_sin_igv"])

            # Margen: (precio_prom_sin_igv - costo) / precio_prom_sin_igv × 100
            precio_prom = (ventas_sin_igv / unidades) if unidades > 0 else 0.0
            costo = float(enriq["costo_manual"] or 0)
            margen_pct: Optional[float] = None
            if costo > 0 and precio_prom > 0:
                margen_pct = round((precio_prom - costo) / precio_prom * 100, 2)

            # Variación vs año anterior
            var_pct: Optional[float] = None
            if anio_compara:
                ant = data_ant.get(tmpl_id)
                v_ant = float(ant["ventas"]) if ant else 0.0
                var_pct = round((ventas - v_ant) / v_ant * 100, 2) if v_ant > 0 else None

            items.append({
                "product_tmpl_id": tmpl_id,
                "sku": str(tmpl_id),  # Odoo no tiene default_code a nivel template sincronizado
                "nombre": enriq["nombre"],
                "marca": enriq["marca_nombre"],
                "tipo": enriq["tipo_nombre"],
                "entalle": enriq["entalle_nombre"],
                "tela": enriq["tela_nombre"],
                "stock": float(enriq["stock"] or 0),
                "costo": costo,
                "precio_promedio": round(precio_prom, 2),
                "margen_pct": margen_pct,
                "ventas": round(ventas, 2),
                "unidades": unidades,
                "tickets": int(venta_data["tickets"]),
                "var_pct": var_pct,
            })

        # 5. Ordenar
        def sort_key(it):
            if orden == "unidades":
                return -it["unidades"]
            if orden == "tickets":
                return -it["tickets"]
            if orden == "margen":
                return -(it["margen_pct"] or -1e9)
            return -it["ventas"]
        items.sort(key=sort_key)

        total = len(items)
        return {
            "items": items[offset:offset + limit],
            "total": total,
            "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
            "anio_compara": anio_compara,
        }


@router.get("/productos/crecen-caen")
async def crecen_caen(
    anio_compara: int = Query(..., description="año contra el que comparar, ej: 2025"),
    top: int = Query(5, ge=1, le=20),
    min_unidades: int = Query(10, ge=0, description="unidades mínimas en ambos períodos"),
    company_key: Optional[str] = None,
    location_id: Optional[int] = None,
    _user: dict = Depends(get_current_user),
):
    """Top N productos que más crecen y top N que más caen en ventas YTD vs año anterior.

    Requiere mínimo `min_unidades` en AMBOS períodos para evitar variaciones extremas
    de productos con data marginal.
    """
    hoy = datetime.now()
    d, h = ytd_rango(hoy.year, hoy)
    d_a, h_a = ytd_rango(anio_compara, hoy)

    pool = await get_pool()
    async with pool.acquire() as conn:
        data_actual = await _ranking_base(conn, d, h, company_key, location_id)
        data_ant = await _ranking_base(conn, d_a, h_a, company_key, location_id)

        # Unión de product_tmpl_ids presentes en AMBOS períodos
        tmpl_ids_both = [
            t for t in set(data_actual) & set(data_ant)
            if float(data_actual[t]["unidades"]) >= min_unidades
               and float(data_ant[t]["unidades"]) >= min_unidades
        ]

        if not tmpl_ids_both:
            return {"crecen": [], "caen": [], "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()}}

        # Metadata (nombre + jerarquía completa marca·tipo·entalle·tela).
        # COALESCE con auto-match por texto (mismo patrón que /productos-odoo/grupos)
        # para no perder productos sin clasificación FK pero con texto válido en pt.*.
        sql = """
        SELECT
            pt.odoo_id AS product_tmpl_id,
            pt.name AS nombre,
            COALESCE(ma.nombre, ma_auto.nombre, NULLIF(pt.marca, '')) AS marca_nombre,
            COALESCE(ti.nombre, ti_auto.nombre, NULLIF(pt.tipo, '')) AS tipo_nombre,
            COALESCE(en.nombre, en_auto.nombre, NULLIF(pt.entalle, '')) AS entalle_nombre,
            COALESCE(te.nombre, te_auto.nombre, NULLIF(pt.tela, '')) AS tela_nombre
        FROM odoo.product_template pt
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        LEFT JOIN produccion.prod_marcas ma ON ma.id = pe.marca_id
        LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
        LEFT JOIN produccion.prod_entalles en ON en.id = pe.entalle_id
        LEFT JOIN produccion.prod_telas te ON te.id = pe.tela_id
        LEFT JOIN produccion.prod_marcas ma_auto
            ON pe.marca_id IS NULL AND pt.marca IS NOT NULL AND pt.marca <> ''
            AND LOWER(TRIM(ma_auto.nombre)) = LOWER(TRIM(pt.marca))
        LEFT JOIN produccion.prod_tipos ti_auto
            ON pe.tipo_id IS NULL AND pt.tipo IS NOT NULL AND pt.tipo <> ''
            AND LOWER(TRIM(ti_auto.nombre)) = LOWER(TRIM(pt.tipo))
        LEFT JOIN produccion.prod_entalles en_auto
            ON pe.entalle_id IS NULL AND pt.entalle IS NOT NULL AND pt.entalle <> ''
            AND LOWER(TRIM(en_auto.nombre)) = LOWER(TRIM(pt.entalle))
        LEFT JOIN produccion.prod_telas te_auto
            ON pe.tela_id IS NULL AND pt.tela IS NOT NULL AND pt.tela <> ''
            AND LOWER(TRIM(te_auto.nombre)) = LOWER(TRIM(pt.tela))
        WHERE pt.odoo_id = ANY($1);
        """
        meta_rows = await conn.fetch(sql, tmpl_ids_both)
        meta = {r["product_tmpl_id"]: dict(r) for r in meta_rows}

        rows = []
        for t in tmpl_ids_both:
            v_act = float(data_actual[t]["ventas"])
            v_ant = float(data_ant[t]["ventas"])
            if v_ant <= 0:
                continue
            var = (v_act - v_ant) / v_ant * 100
            m = meta.get(t, {})
            rows.append({
                "product_tmpl_id": t,
                "nombre": m.get("nombre"),
                "marca": m.get("marca_nombre"),
                "tipo": m.get("tipo_nombre"),
                "entalle": m.get("entalle_nombre"),
                "tela": m.get("tela_nombre"),
                "ventas_actual": round(v_act, 2),
                "ventas_anterior": round(v_ant, 2),
                "unidades_actual": float(data_actual[t]["unidades"]),
                "unidades_anterior": float(data_ant[t]["unidades"]),
                "var_pct": round(var, 2),
            })

        # Separar por signo: crecen = var>0 (desc), caen = var<0 (asc)
        positivos = sorted([r for r in rows if r["var_pct"] > 0], key=lambda x: -x["var_pct"])
        negativos = sorted([r for r in rows if r["var_pct"] < 0], key=lambda x: x["var_pct"])
        crecen = positivos[:top]
        caen = negativos[:top]

        return {
            "crecen": crecen,
            "caen": caen,
            "anio_compara": anio_compara,
            "min_unidades": min_unidades,
            "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
            "periodo_compara": {"desde": d_a.date().isoformat(), "hasta": h_a.date().isoformat()},
        }


# ============================================================
# /productos/{tmpl_id}/detalle — drill-down completo de un producto
# ============================================================
@router.get("/productos/{tmpl_id}/detalle")
async def producto_detalle(
    tmpl_id: int,
    meses: int = Query(12, ge=3, le=36, description="Histórico de meses hacia atrás"),
    _user: dict = Depends(get_current_user),
):
    """Retorna toda la info del drill-down de UN producto:
       - metadata (nombre, marca, tipo, etc.)
       - histórico mensual de ventas (últimos N meses)
       - tiendas que lo venden (con totales YTD)
       - clientes top (10 con más compras)
       - stock actual por ubicación
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        # 1. Metadata del producto
        meta = await conn.fetchrow("""
            SELECT
                pt.odoo_id AS tmpl_id,
                pt.name AS nombre,
                pt.list_price,
                COALESCE(ma.nombre, ma_auto.nombre, pt.marca) AS marca,
                COALESCE(ti.nombre, ti_auto.nombre, pt.tipo) AS tipo,
                COALESCE(en.nombre, en_auto.nombre, pt.entalle) AS entalle,
                COALESCE(te.nombre, te_auto.nombre, pt.tela) AS tela,
                pe.estado AS estado_clasif
            FROM odoo.product_template pt
            LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
            LEFT JOIN produccion.prod_marcas ma ON ma.id = pe.marca_id
            LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
            LEFT JOIN produccion.prod_entalles en ON en.id = pe.entalle_id
            LEFT JOIN produccion.prod_telas te ON te.id = pe.tela_id
            LEFT JOIN produccion.prod_marcas ma_auto
              ON pe.marca_id IS NULL AND LOWER(TRIM(ma_auto.nombre)) = LOWER(TRIM(pt.marca))
            LEFT JOIN produccion.prod_tipos ti_auto
              ON pe.tipo_id IS NULL AND LOWER(TRIM(ti_auto.nombre)) = LOWER(TRIM(SPLIT_PART(pt.tipo, ' ', 1)))
            LEFT JOIN produccion.prod_entalles en_auto
              ON pe.entalle_id IS NULL AND LOWER(TRIM(en_auto.nombre)) = LOWER(TRIM(pt.entalle))
            LEFT JOIN produccion.prod_telas te_auto
              ON pe.tela_id IS NULL AND LOWER(TRIM(te_auto.nombre)) = LOWER(TRIM(pt.tela))
            WHERE pt.odoo_id = $1
            LIMIT 1;
        """, tmpl_id)

        if not meta:
            from fastapi import HTTPException
            raise HTTPException(404, "Producto no encontrado")

        # 2. Histórico mensual (últimos N meses, en hora Lima)
        from datetime import timedelta
        hoy = datetime.now()
        desde_dt = hoy.replace(day=1) - timedelta(days=meses * 31)
        hist = await conn.fetch(f"""
            WITH lineas AS (
                SELECT
                    EXTRACT(YEAR  FROM (v.date_order AT TIME ZONE 'America/Lima'))::int AS anio,
                    EXTRACT(MONTH FROM (v.date_order AT TIME ZONE 'America/Lima'))::int AS mes,
                    v.order_id, v.qty, v.price_subtotal, po.amount_total
                {VENTA_REAL_FROM}
                WHERE v.date_order >= $1
                  AND v.product_tmpl_id = $2
                  AND {VENTA_REAL_WHERE}
            ),
            ord AS (SELECT DISTINCT anio, mes, order_id FROM lineas)
            SELECT
                l.anio, l.mes,
                SUM(l.price_subtotal * 1.18)::numeric(14,2) AS ventas,
                SUM(l.qty)::numeric(14,2) AS unidades,
                (SELECT COUNT(*) FROM ord o WHERE o.anio = l.anio AND o.mes = l.mes) AS tickets
            FROM lineas l
            GROUP BY l.anio, l.mes
            ORDER BY l.anio, l.mes;
        """, desde_dt, tmpl_id)

        # 3. Tiendas que lo venden (top por ventas)
        tiendas = await conn.fetch(f"""
            WITH ord AS (
                SELECT DISTINCT v.order_id, po.location_id, po.amount_total, sl.x_nombre AS tienda
                {VENTA_REAL_FROM}
                LEFT JOIN odoo.stock_location sl ON sl.odoo_id = po.location_id
                WHERE v.date_order >= $1
                  AND v.product_tmpl_id = $2
                  AND {VENTA_REAL_WHERE}
                  AND sl.x_nombre IS NOT NULL
            ),
            unidades AS (
                SELECT po.location_id, SUM(v.qty)::numeric(14,2) AS und
                {VENTA_REAL_FROM}
                WHERE v.date_order >= $1
                  AND v.product_tmpl_id = $2
                  AND {VENTA_REAL_WHERE}
                GROUP BY 1
            )
            SELECT ord.tienda,
                   SUM(ord.amount_total)::numeric(14,2) AS ventas,
                   COUNT(DISTINCT ord.order_id) AS tickets,
                   COALESCE(MAX(u.und), 0) AS unidades
            FROM ord
            LEFT JOIN unidades u ON u.location_id = ord.location_id
            GROUP BY ord.tienda
            ORDER BY ventas DESC
            LIMIT 20;
        """, desde_dt, tmpl_id)

        # 4. Clientes top
        clientes = await conn.fetch(f"""
            SELECT
                COALESCE(po.x_cliente_principal, v.cuenta_partner_id) AS cliente_id,
                rp.name AS nombre,
                COUNT(DISTINCT v.order_id) AS tickets,
                SUM(v.qty)::numeric(14,2) AS unidades,
                SUM(v.price_subtotal * 1.18)::numeric(14,2) AS ventas,
                MAX(v.date_order)::date AS ultima_compra
            {VENTA_REAL_FROM}
            LEFT JOIN odoo.res_partner rp
              ON rp.odoo_id = COALESCE(po.x_cliente_principal, v.cuenta_partner_id)
            WHERE v.date_order >= $1
              AND v.product_tmpl_id = $2
              AND {VENTA_REAL_WHERE}
              AND COALESCE(po.x_cliente_principal, v.cuenta_partner_id) IS NOT NULL
            GROUP BY 1, 2
            ORDER BY ventas DESC
            LIMIT 10;
        """, desde_dt, tmpl_id)

        # 5. Stock actual por ubicación
        stock = await conn.fetch("""
            SELECT sl.x_nombre AS tienda, COALESCE(SUM(q.qty), 0)::int AS stock
            FROM odoo.stock_quant q
            JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
            JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
              AND sl.usage = 'internal' AND sl.active = true
            WHERE q.qty > 0
              AND pp.product_tmpl_id = $1
            GROUP BY 1
            HAVING SUM(q.qty) > 0
            ORDER BY 2 DESC;
        """, tmpl_id)

        return {
            "producto": dict(meta),
            "historico_mensual": [
                {
                    "mes": f"{int(r['anio'])}-{str(int(r['mes'])).zfill(2)}",
                    "anio": int(r["anio"]),
                    "mes_num": int(r["mes"]),
                    "ventas": float(r["ventas"] or 0),
                    "unidades": float(r["unidades"] or 0),
                    "tickets": int(r["tickets"] or 0),
                } for r in hist
            ],
            "tiendas": [
                {
                    "tienda": r["tienda"],
                    "ventas": float(r["ventas"] or 0),
                    "unidades": float(r["unidades"] or 0),
                    "tickets": int(r["tickets"] or 0),
                } for r in tiendas
            ],
            "clientes_top": [
                {
                    "cliente_id": r["cliente_id"],
                    "nombre": r["nombre"],
                    "ventas": float(r["ventas"] or 0),
                    "unidades": float(r["unidades"] or 0),
                    "tickets": int(r["tickets"] or 0),
                    "ultima_compra": r["ultima_compra"].isoformat() if r["ultima_compra"] else None,
                } for r in clientes
            ],
            "stock_por_tienda": [
                {"tienda": r["tienda"], "stock": int(r["stock"])} for r in stock
            ],
            "stock_total": sum(int(r["stock"]) for r in stock),
            "meses_consultados": meses,
        }
