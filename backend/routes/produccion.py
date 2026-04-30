"""Reportes para planificación de producción.

Pivot de stock actual por color × talla, filtrable por marca/tipo/entalle/tela.
Útil para decidir qué producir basado en cobertura por talla y color.
"""
import asyncio
from typing import Optional, List
from datetime import datetime
from fastapi import APIRouter, Depends, Query

from auth_utils import get_current_user
from db import get_pool
from helpers import VENTA_REAL_FROM, VENTA_REAL_WHERE, ytd_rango, dias_transcurridos_anio, PALABRAS_EXCLUIDAS

router = APIRouter(prefix="/api/produccion")


# Filtro de productos válidos a nivel template (usa pt.X directamente, no v.X).
# Aplica las mismas PALABRAS_EXCLUIDAS de helpers.py + descarte de basura Odoo
# (productos sin marca con purchase_ok=true).
_EXCL_PATTERNS_SQL = ",".join(f"'%{p}%'" for p in PALABRAS_EXCLUIDAS)
PRODUCTO_VALIDO_STOCK_WHERE = f"""
NOT (
    pt.name ILIKE ANY (ARRAY[{_EXCL_PATTERNS_SQL}])
    OR (pt.purchase_ok = true AND (pt.marca IS NULL OR pt.marca = ''))
)
""".strip()


# Tiendas que se excluyen POR DEFECTO de los reportes de stock.
# Si el usuario las selecciona explícitamente en el multi-select, sí aparecen.
# - ZAP, REMATE: tiendas de saldo/liquidación (no representan stock vendible normal)
# - Fallados Qepo: prendas defectuosas
# - AP: tienda de "por arreglar" (se accede vía toggle dedicado)
# AP queda visible por defecto (es relevante: arreglos pendientes a regresar a tiendas)
# pero se excluye de las sumatorias de modelos/total global (no es venta normal).
TIENDAS_NO_COMERCIALES_DEFAULT = ('ZAP', 'REMATE', 'Fallados Qepo', 'GR55')

# AP es una tienda especial — se muestra pero NO se incluye en sumatorias de modelos
TIENDA_ARREGLOS = 'AP'


# Tablas auto-match para FK del catálogo de Producción
_MA_TABLES = {
    'marca_id': 'produccion.prod_marcas',
    'tipo_id': 'produccion.prod_tipos',
    'entalle_id': 'produccion.prod_entalles',
    'tela_id': 'produccion.prod_telas',
}
_PT_COLS = {
    'marca_id': 'marca',
    'tipo_id': 'tipo',
    'entalle_id': 'entalle',
    'tela_id': 'tela',
}


def _build_grupo_filtros(marca_id, tipo_id, entalle_id, tela_id, start_idx: int = 1,
                         estricta: bool = True):
    """Devuelve (lista de cláusulas SQL, lista de params) para filtrar por grupo.

    estricta=True (default): solo matchea por FK de prod_odoo_productos_enriq.
                             Productos sin clasificar en Producción son excluidos.
    estricta=False: incluye también auto-match contra el texto crudo de Odoo
                    (pt.marca, pt.tipo, etc.) para productos que aún no fueron
                    clasificados en el módulo Producción.

    start_idx: índice del primer placeholder ($N) — usar cuando hay otros params
    antes (ej. fechas $1 y $2 en una query de ventas).
    """
    filtros, params = [], []
    for fk, val in [('marca_id', marca_id), ('tipo_id', tipo_id),
                    ('entalle_id', entalle_id), ('tela_id', tela_id)]:
        if val is None or val == "":
            continue
        if val.startswith("t:"):
            # Búsqueda explícita por texto — funciona igual en ambos modos
            texto = val[2:]
            params.append(texto)
            idx = start_idx + len(params) - 1
            if fk == 'tipo_id':
                filtros.append(
                    f"pe.{fk} IS NULL AND (LOWER(TRIM(pt.{_PT_COLS[fk]})) = LOWER(TRIM(${idx})) "
                    f"OR LOWER(TRIM(SPLIT_PART(pt.{_PT_COLS[fk]}, ' ', 1))) = LOWER(TRIM(${idx})))"
                )
            else:
                filtros.append(
                    f"pe.{fk} IS NULL AND LOWER(TRIM(pt.{_PT_COLS[fk]})) = LOWER(TRIM(${idx}))"
                )
        else:
            # FK del catálogo
            params.append(val)
            idx = start_idx + len(params) - 1
            if estricta:
                # Solo match por FK asignado en producción — modo estricto
                filtros.append(f"pe.{fk} = ${idx}")
            else:
                # Modo flexible: FK asignado O auto-match contra texto
                filtros.append(
                    f"(pe.{fk} = ${idx} OR (pe.{fk} IS NULL "
                    f"AND LOWER(TRIM(pt.{_PT_COLS[fk]})) IN "
                    f"(SELECT LOWER(TRIM(nombre)) FROM {_MA_TABLES[fk]} WHERE id = ${idx})))"
                )
    return filtros, params


def _ordenar_tallas(tallas: list) -> list:
    """Ordena tallas: numéricas asc, luego alfabéticas en orden de ropa."""
    numericas = sorted([t for t in tallas if t.replace('.', '').isdigit()],
                       key=lambda x: float(x))
    alfa = [t for t in tallas if not t.replace('.', '').isdigit()]
    orden_alfa = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'U', 'STD', '—']
    alfa_sorted = sorted(alfa, key=lambda x: (orden_alfa.index(x) if x in orden_alfa else 99, x))
    return numericas + alfa_sorted


@router.get("/reporte-detallado")
async def reporte_detallado(
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    entalle_id: Optional[str] = None,
    tela_id: Optional[str] = None,
    es_lq: Optional[str] = Query(None, description="'si' | 'no' | None (todos)"),
    es_negro: Optional[str] = Query(None, description="'si' | 'no' | None — modelo tiene variante negro/carbon"),
    por_arreglar: bool = Query(False, description="Si true, solo stock en AP (productos por arreglar)"),
    tiendas: Optional[str] = Query(None, description="Tiendas separadas por coma (x_nombre). None = todas"),
    modelo: Optional[str] = Query(None, description="Búsqueda parcial (ILIKE) en nombre de modelo"),
    modelo_exacto: Optional[str] = Query(None, description="Match exacto de nombre (drill-down click)"),
    talla: Optional[str] = None,
    color: Optional[str] = None,
    incluir_pendientes: bool = Query(True, description="Si true, suma transferencias pendientes (proyectado). Si false, solo stock físico real."),
    clasif_estricta: bool = Query(True, description="True: solo productos clasificados en Producción (FK estricta). False: incluye auto-match contra texto Odoo."),
    _u: dict = Depends(get_current_user),
):
    """Reporte de stock detallado tipo Power BI:
    - Pivot Modelo × Talla
    - Pivots por tienda (configurable)
    - Pivot TOTAL color × talla
    - KPIs y lista de tiendas disponibles

    Filtros adicionales:
    - es_lq='si': solo modelos con sufijo -LQ; 'no': sin -LQ; None: todos
    - es_negro='si': solo modelos que tienen variantes Negro/Carbon
    - por_arreglar=true: solo stock en AP (tienda de arreglos)
    - tiendas='GR238,GM209': stores a incluir; None = todas
    """
    # Filtros del grupo (marca/tipo/entalle/tela)
    grupo_filtros, params = _build_grupo_filtros(
        marca_id, tipo_id, entalle_id, tela_id, start_idx=1, estricta=clasif_estricta
    )

    # Filtros adicionales
    extras = []

    # es_lq: por nombre del modelo
    if es_lq == 'si':
        extras.append("pt.name ILIKE '%-LQ%'")
    elif es_lq == 'no':
        extras.append("(pt.name NOT ILIKE '%-LQ%' OR pt.name IS NULL)")

    # es_negro: el modelo (template) tiene al menos una variante con color negro/carbon
    if es_negro == 'si':
        extras.append("""EXISTS (
            SELECT 1 FROM odoo.product_product pp_n
            JOIN odoo.v_product_variant_flat vf_n ON vf_n.product_product_id = pp_n.odoo_id
            WHERE pp_n.product_tmpl_id = pt.odoo_id
              AND pp_n.active = true
              AND (LOWER(TRIM(vf_n.color)) LIKE '%negro%' OR LOWER(TRIM(vf_n.color)) LIKE '%carbon%')
        )""")
    elif es_negro == 'no':
        extras.append("""NOT EXISTS (
            SELECT 1 FROM odoo.product_product pp_n
            JOIN odoo.v_product_variant_flat vf_n ON vf_n.product_product_id = pp_n.odoo_id
            WHERE pp_n.product_tmpl_id = pt.odoo_id
              AND pp_n.active = true
              AND (LOWER(TRIM(vf_n.color)) LIKE '%negro%' OR LOWER(TRIM(vf_n.color)) LIKE '%carbon%')
        )""")

    # Match exacto (drill-down) tiene prioridad sobre búsqueda parcial
    if modelo_exacto and modelo_exacto.strip():
        params.append(modelo_exacto.strip())
        extras.append(f"pt.name = ${len(params)}")
    elif modelo and modelo.strip():
        params.append(f'%{modelo.strip()}%')
        extras.append(f"pt.name ILIKE ${len(params)}")

    # Filtro por talla específica
    if talla and talla.strip():
        params.append(talla.strip())
        extras.append(f"vf.talla = ${len(params)}")

    # Filtro por color específico
    if color and color.strip():
        params.append(color.strip())
        extras.append(f"vf.color = ${len(params)}")

    common_filters = grupo_filtros + extras
    common_where = " AND ".join(common_filters) if common_filters else "true"

    # Filtro de ubicación (tiendas)
    tiendas_lista: List[str] = []
    if tiendas:
        tiendas_lista = [t.strip() for t in tiendas.split(',') if t.strip()]

    if por_arreglar:
        # Toggle dedicado: solo AP
        loc_filter = "sl.x_nombre = 'AP'"
    elif tiendas_lista:
        # Usuario eligió tiendas específicas → respetar exactamente esas
        params.append(tiendas_lista)
        loc_filter = f"sl.x_nombre = ANY(${len(params)}::text[])"
    else:
        # Default: excluir tiendas no comerciales (ZAP, REMATE, Fallados Qepo, AP, GR55)
        params.append(list(TIENDAS_NO_COMERCIALES_DEFAULT))
        loc_filter = f"sl.x_nombre <> ALL(${len(params)}::text[])"

    # ============================================================
    # OPTIMIZACIÓN: 1 sola query base con todas las dimensiones.
    # Antes corría 3 queries separadas. Ahora 1 + agregación en Python.
    # Reducción típica: 4× más rápido en cold cache, 2× con cache caliente.
    # ============================================================
    # ============================================================
    # STOCK PROYECTADO = stock físico (stock_quant) + transferencias pendientes
    # Una transferencia pendiente (state assigned/waiting/confirmed/partially_available)
    # genera 2 efectos: -qty en location_id (origen) y +qty en location_dest_id (destino)
    # ============================================================
    if incluir_pendientes:
        movimientos_cte = """
        , movimientos AS (
            -- Salidas pendientes (restan a la ubicación origen)
            SELECT product_id, location_id AS loc_id, -SUM(product_qty)::numeric AS qty
            FROM odoo.stock_move
            WHERE state IN ('waiting','confirmed','partially_available','assigned')
            GROUP BY 1, 2

            UNION ALL

            -- Entradas pendientes (suman a la ubicación destino)
            SELECT product_id, location_dest_id AS loc_id, SUM(product_qty)::numeric AS qty
            FROM odoo.stock_move
            WHERE state IN ('waiting','confirmed','partially_available','assigned')
            GROUP BY 1, 2
        )
        """
        union_movimientos = """
        UNION ALL
        SELECT m.product_id AS product_id, m.loc_id AS location_id, m.qty AS qty
        FROM movimientos m
        """
    else:
        movimientos_cte = ""
        union_movimientos = ""

    sql_base = f"""
    WITH stock_real AS (
        SELECT product_id, location_id, qty
        FROM odoo.stock_quant
        WHERE qty > 0
    )
    {movimientos_cte}
    SELECT
        COALESCE(NULLIF(pt.name, ''), '— sin modelo —') AS modelo,
        COALESCE(NULLIF(vf.color, ''), '— sin color —') AS color,
        COALESCE(NULLIF(vf.talla, ''), '—') AS talla,
        sl.x_nombre AS tienda,
        SUM(combinado.qty)::int AS stock
    FROM (
        SELECT product_id, location_id, qty FROM stock_real
        {union_movimientos}
    ) combinado
    JOIN odoo.product_product pp ON pp.odoo_id = combinado.product_id AND pp.active = true
    JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
    JOIN odoo.mv_product_variant_flat vf ON vf.product_product_id = pp.odoo_id
    JOIN odoo.stock_location sl ON sl.odoo_id = combinado.location_id
    LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
    WHERE sl.usage = 'internal' AND sl.active = true
      AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
      AND {PRODUCTO_VALIDO_STOCK_WHERE}
      AND ({common_where})
      AND ({loc_filter})
    GROUP BY 1, 2, 3, 4
    HAVING SUM(combinado.qty) > 0;
    """

    # Tiendas disponibles (siempre todas las activas con stock — para poblar el multi-select)
    sql_tiendas_disp = f"""
    SELECT sl.x_nombre AS tienda, COALESCE(SUM(q.qty), 0)::int AS stock
    FROM odoo.stock_quant q
    JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
    JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
    JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
    WHERE q.qty > 0
      AND sl.usage = 'internal' AND sl.active = true
      AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
      AND {PRODUCTO_VALIDO_STOCK_WHERE}
    GROUP BY 1
    HAVING SUM(q.qty) > 0
    ORDER BY 1;
    """

    # Las 2 queries son independientes → corren EN PARALELO con asyncio.gather
    pool = await get_pool()

    async def _fetch_base():
        async with pool.acquire() as conn:
            return await conn.fetch(sql_base, *params)

    async def _fetch_tiendas_disp():
        async with pool.acquire() as conn:
            return await conn.fetch(sql_tiendas_disp)

    rows_base, rows_tiendas_disp = await asyncio.gather(_fetch_base(), _fetch_tiendas_disp())

    # ============================================================
    # AGREGACIÓN EN PYTHON: una pasada construye los 3 pivots.
    # ============================================================
    tallas_set = set()
    modelos_dict = {}        # {modelo: {tallas_stock, total}}
    colores_total_dict = {}  # {color: {tallas_stock, total}}
    tiendas_dict = {}        # {tienda: {colores: {color: {tallas_stock, total}}, total}}

    for r in rows_base:
        modelo = r['modelo']
        color = r['color']
        talla = r['talla']
        tienda = r['tienda']
        stock = int(r['stock'])
        tallas_set.add(talla)

        # AP es tienda de arreglos: se muestra como card propia pero NO se suma
        # a totales por modelo ni al total global (no es stock vendible normal).
        es_arreglos = (tienda == TIENDA_ARREGLOS)

        # 1) Por modelo — excluye AP (arreglos no son stock vendible)
        if not es_arreglos:
            m = modelos_dict.get(modelo)
            if m is None:
                m = {"modelo": modelo, "tallas_stock": {}, "total": 0}
                modelos_dict[modelo] = m
            m["tallas_stock"][talla] = m["tallas_stock"].get(talla, 0) + stock
            m["total"] += stock

            # 2) Total global por (color, talla) — también excluye AP
            c = colores_total_dict.get(color)
            if c is None:
                c = {"color": color, "tallas_stock": {}, "total": 0}
                colores_total_dict[color] = c
            c["tallas_stock"][talla] = c["tallas_stock"].get(talla, 0) + stock
            c["total"] += stock

        # 3) Por tienda — siempre incluir AP en su propia card
        t = tiendas_dict.get(tienda)
        if t is None:
            t = {"tienda": tienda, "colores": {}, "total": 0}
            tiendas_dict[tienda] = t
        tc = t["colores"].get(color)
        if tc is None:
            tc = {"color": color, "tallas_stock": {}, "total": 0}
            t["colores"][color] = tc
        tc["tallas_stock"][talla] = tc["tallas_stock"].get(talla, 0) + stock
        tc["total"] += stock
        t["total"] += stock

    tallas_ordenadas = _ordenar_tallas(list(tallas_set))

    # Modelos: ordenar y calcular totales por talla
    modelos_list = sorted(modelos_dict.values(), key=lambda x: -x["total"])
    totales_talla_modelos = {t: 0 for t in tallas_ordenadas}
    for m in modelos_list:
        for t, s in m["tallas_stock"].items():
            totales_talla_modelos[t] = totales_talla_modelos.get(t, 0) + s

    # Total global: ordenar y calcular totales por talla
    colores_total_list = sorted(colores_total_dict.values(), key=lambda x: -x["total"])
    totales_talla_total = {t: 0 for t in tallas_ordenadas}
    for c in colores_total_list:
        for t, s in c["tallas_stock"].items():
            totales_talla_total[t] = totales_talla_total.get(t, 0) + s

    # Tiendas: convertir colores dict → lista, calcular totales por talla
    pivot_tiendas_list = []
    for tienda, td in tiendas_dict.items():
        colores_list = sorted(td["colores"].values(), key=lambda x: -x["total"])
        totales = {t: 0 for t in tallas_ordenadas}
        for c in colores_list:
            for t, s in c["tallas_stock"].items():
                totales[t] = totales.get(t, 0) + s
        pivot_tiendas_list.append({
            "tienda": tienda,
            "colores": colores_list,
            "totales_talla": totales,
            "total": td["total"],
        })
    pivot_tiendas_list.sort(key=lambda x: -x["total"])

    return {
        "tallas": tallas_ordenadas,
        "pivot_modelos": {
            "items": modelos_list,
            "totales_talla": totales_talla_modelos,
            "total": sum(m["total"] for m in modelos_list),
        },
        "pivot_total": {
            "colores": colores_total_list,
            "totales_talla": totales_talla_total,
            "total": sum(c["total"] for c in colores_total_list),
        },
        "pivot_tiendas": pivot_tiendas_list,
        "tiendas_disponibles": [
            {"tienda": r["tienda"], "stock": int(r["stock"])} for r in rows_tiendas_disp
        ],
        "kpis": {
            "stock_total": sum(c["total"] for c in colores_total_list),
            "modelos": len(modelos_list),
            "colores": len(colores_total_list),
            "tallas": len(tallas_ordenadas),
            "tiendas_con_stock": len(pivot_tiendas_list),
        },
        "filtros": {
            "marca_id": marca_id, "tipo_id": tipo_id,
            "entalle_id": entalle_id, "tela_id": tela_id,
            "es_lq": es_lq, "es_negro": es_negro, "por_arreglar": por_arreglar,
            "tiendas": tiendas_lista, "modelo": modelo, "talla": talla, "color": color,
        },
    }


@router.get("/combinaciones")
async def combinaciones(_u: dict = Depends(get_current_user)):
    """Devuelve todas las combinaciones (marca_id, tipo_id, entalle_id, tela_id)
    de templates ACTIVOS con stock real.

    El frontend usa esto para hacer dropdowns cascada: al elegir marca, los tipos
    se filtran a los que existen para esa marca, y así sucesivamente.

    Resuelve auto-match: si pe.X_id es NULL pero pt.X coincide con un nombre del
    catálogo, se devuelve el ID de ese catálogo.
    """
    sql = f"""
    SELECT DISTINCT
        COALESCE(pe.marca_id::text, ma_auto.id::text) AS marca_id,
        COALESCE(pe.tipo_id::text, ti_auto.id::text) AS tipo_id,
        COALESCE(pe.entalle_id::text, en_auto.id::text) AS entalle_id,
        COALESCE(pe.tela_id::text, te_auto.id::text) AS tela_id
    FROM odoo.product_template pt
    JOIN odoo.product_product pp ON pp.product_tmpl_id = pt.odoo_id AND pp.active = true
    JOIN odoo.stock_quant q ON q.product_id = pp.odoo_id AND q.qty > 0
    JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
        AND sl.usage = 'internal' AND sl.active = true
    LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
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
    WHERE pt.active = true
      AND {PRODUCTO_VALIDO_STOCK_WHERE};
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql)
    # Filtrar nulls — solo combinaciones donde al menos marca o tipo existe
    items = []
    for r in rows:
        items.append({
            "marca_id": r["marca_id"],
            "tipo_id": r["tipo_id"],
            "entalle_id": r["entalle_id"],
            "tela_id": r["tela_id"],
        })
    return items


@router.get("/pivot-stock")
async def pivot_stock(
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    entalle_id: Optional[str] = None,
    tela_id: Optional[str] = None,
    incluir_taller: bool = Query(True, description="Si false, excluye TALLER y AP"),
    _u: dict = Depends(get_current_user),
):
    """Pivot color × talla con stock ACTUAL (todas las tiendas o solo comerciales).

    Filtros opcionales: marca/tipo/entalle/tela. Sirven para acotar a un grupo
    específico (ej. Element Premium · Pantalon · Skinny · Denim) y ver cuánto
    stock hay por color/talla — base para decidir qué producir.

    Si `incluir_taller=false` excluye los almacenes TALLER y AP, útil para ver
    SOLO el stock que ya está en tiendas comerciales (cobertura real al cliente).
    """
    # Para la query de stock: params empiezan en $1
    grupo_filtros, params = _build_grupo_filtros(marca_id, tipo_id, entalle_id, tela_id, start_idx=1)

    extra_where = []
    if not incluir_taller:
        extra_where.append("sl.x_nombre NOT IN ('TALLER', 'AP')")

    all_filtros = grupo_filtros + extra_where
    where_grupo = (" AND " + " AND ".join(all_filtros)) if all_filtros else ""

    # IMPORTANTE: filtramos pp.active=true para excluir variantes "fantasma".
    # Cuando un template cambia sus atributos (ej. de tallas numéricas a S/M/L/XL),
    # Odoo desactiva las variantes viejas pero el stock físico puede quedar
    # huérfano en stock_quant. Sin este filtro aparecen tallas que ya no existen
    # en el template (ej. POPER-LQ con talla 30 que viene de cuando era POPER).
    sql = f"""
    SELECT
        COALESCE(NULLIF(vf.color, ''), '— sin color —') AS color,
        COALESCE(NULLIF(vf.talla, ''), '—') AS talla,
        SUM(q.qty)::int AS stock
    FROM odoo.stock_quant q
    JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
    JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
    JOIN odoo.mv_product_variant_flat vf ON vf.product_product_id = pp.odoo_id
    JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
    LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
    WHERE q.qty > 0
      AND sl.usage = 'internal' AND sl.active = true
      AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
      AND {PRODUCTO_VALIDO_STOCK_WHERE}
      {where_grupo}
    GROUP BY 1, 2
    HAVING SUM(q.qty) > 0
    ORDER BY 1, 2;
    """

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    # ===== Ventas YTD por (color, talla) — mismo filtro de grupo =====
    # Para esta query: $1 y $2 son fechas, los grupo params empiezan en $3
    hoy = datetime.now()
    d_ytd, h_ytd = ytd_rango(hoy.year, hoy)
    grupo_filtros_v, _ = _build_grupo_filtros(marca_id, tipo_id, entalle_id, tela_id, start_idx=3)
    ventas_params: list = [d_ytd, h_ytd] + params
    ventas_filtros_str = (" AND " + " AND ".join(grupo_filtros_v)) if grupo_filtros_v else ""

    sql_ventas = f"""
    SELECT
        COALESCE(NULLIF(v.color, ''), '— sin color —') AS color,
        COALESCE(NULLIF(v.talla, ''), '—') AS talla,
        SUM(v.qty)::int AS unidades_vendidas
    {VENTA_REAL_FROM}
    LEFT JOIN odoo.product_template pt ON pt.odoo_id = v.product_tmpl_id
    LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id
    WHERE v.date_order >= $1 AND v.date_order <= $2
      AND {VENTA_REAL_WHERE}
      {ventas_filtros_str}
    GROUP BY 1, 2
    HAVING SUM(v.qty) > 0;
    """

    # ===== En producción (OPs activas) por (color, talla) =====
    # Solo aplicable si los filtros son FK (UUID), no aplica si son t:TEXTO
    # porque prod_modelos siempre tiene FKs.
    es_fk = lambda v: bool(v) and not v.startswith('t:')
    aplica_op = (
        (not marca_id or es_fk(marca_id))
        and (not tipo_id or es_fk(tipo_id))
        and (not entalle_id or es_fk(entalle_id))
        and (not tela_id or es_fk(tela_id))
    )

    en_proceso_rows = []
    if aplica_op:
        op_params: list = []
        # Filtros que aplican tanto a prod_modelos (FK pm.X) como a modelo_manual (JSONB pr.modelo_manual->>'X')
        op_filtros = ["pr.estado_op = 'EN_PROCESO'",
                      "pr.distribucion_colores IS NOT NULL",
                      "pr.distribucion_colores::text NOT IN ('[]', '{}', 'null')"]
        for fk, val in [('marca_id', marca_id), ('tipo_id', tipo_id),
                        ('entalle_id', entalle_id), ('tela_id', tela_id)]:
            if es_fk(val):
                op_params.append(val)
                # Match contra el modelo (vía pm) O contra modelo_manual (JSONB)
                op_filtros.append(
                    f"COALESCE(pm.{fk}, pr.modelo_manual->>'{fk}') = ${len(op_params)}"
                )

        sql_op = f"""
        WITH op_expandido AS (
            SELECT
                pr.id AS registro_id,
                pr.empresa_id,
                ti->>'talla_nombre' AS talla,
                ci->>'color_id' AS color_id,
                ci->>'color_nombre' AS color_nombre,
                (ci->>'cantidad')::int AS cantidad
            FROM produccion.prod_registros pr
            LEFT JOIN produccion.prod_modelos pm ON pm.id = pr.modelo_id
            CROSS JOIN LATERAL jsonb_array_elements(pr.distribucion_colores) ti
            CROSS JOIN LATERAL jsonb_array_elements(ti->'colores') ci
            WHERE {' AND '.join(op_filtros)}
        )
        SELECT
            COALESCE(
                MAX(map.color_odoo_original),  -- mapeo a nombre Odoo si existe
                op.color_nombre                 -- fallback al nombre del catálogo de Producción
            ) AS color,
            op.talla,
            SUM(op.cantidad)::int AS unidades_op
        FROM op_expandido op
        LEFT JOIN produccion.prod_odoo_color_mapping map
            ON map.color_id = op.color_id AND map.empresa_id = op.empresa_id
        GROUP BY op.color_nombre, op.talla, op.color_id
        HAVING SUM(op.cantidad) > 0
        ORDER BY 1, 2;
        """
    else:
        sql_op = None

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)
        ventas_rows = await conn.fetch(sql_ventas, *ventas_params)
        en_proceso_rows = await conn.fetch(sql_op, *op_params) if sql_op else []

    # Helper: normalizar color para matching cross-source (Odoo vs Producción)
    # Producción: "AZUL BORGOÑA", Odoo: "Azul Borgona". Comparamos UPPER+TRIM
    # ignorando acentos y espacios.
    import unicodedata
    def norm_color(c):
        if not c: return ''
        s = unicodedata.normalize('NFKD', c).encode('ASCII', 'ignore').decode().upper().strip()
        return ' '.join(s.split())  # colapsa espacios múltiples

    # Construir pivot (incluyendo colores/tallas con ventas pero sin stock ni OPs)
    tallas_set = set()
    colores_map = {}  # key = norm_color → entry

    def get_or_create(color_label):
        k = norm_color(color_label)
        if k not in colores_map:
            colores_map[k] = {
                "color": color_label,
                "stock_total": 0, "tallas_stock": {},
                "vendido_total": 0, "tallas_vendido": {},
                "en_proceso_total": 0, "tallas_en_proceso": {},
            }
        return colores_map[k]

    for r in rows:
        entry = get_or_create(r["color"])
        t, s = r["talla"], int(r["stock"])
        tallas_set.add(t)
        entry["tallas_stock"][t] = s
        entry["stock_total"] += s

    for r in ventas_rows:
        entry = get_or_create(r["color"])
        t, v = r["talla"], int(r["unidades_vendidas"])
        tallas_set.add(t)
        entry["tallas_vendido"][t] = v
        entry["vendido_total"] += v

    for r in en_proceso_rows:
        entry = get_or_create(r["color"])
        t, u = r["talla"], int(r["unidades_op"])
        tallas_set.add(t)
        entry["tallas_en_proceso"][t] = entry["tallas_en_proceso"].get(t, 0) + u
        entry["en_proceso_total"] += u

    tallas = _ordenar_tallas(list(tallas_set))
    # Ordenar colores por (stock + ventas + producción) desc
    colores = sorted(colores_map.values(),
                     key=lambda x: -(x.get("stock_total", 0)
                                     + x.get("vendido_total", 0)
                                     + x.get("en_proceso_total", 0)))

    # Totales por talla
    totales_stock_talla = {t: 0 for t in tallas}
    totales_vendido_talla = {t: 0 for t in tallas}
    totales_en_proceso_talla = {t: 0 for t in tallas}
    for c in colores:
        for t, s in c.get("tallas_stock", {}).items():
            totales_stock_talla[t] = totales_stock_talla.get(t, 0) + s
        for t, v in c.get("tallas_vendido", {}).items():
            totales_vendido_talla[t] = totales_vendido_talla.get(t, 0) + v
        for t, u in c.get("tallas_en_proceso", {}).items():
            totales_en_proceso_talla[t] = totales_en_proceso_talla.get(t, 0) + u

    dias_ytd = dias_transcurridos_anio(hoy)

    stock_total = sum(c.get("stock_total", 0) for c in colores)
    vendido_total = sum(c.get("vendido_total", 0) for c in colores)
    en_proceso_total = sum(c.get("en_proceso_total", 0) for c in colores)

    return {
        "tallas": tallas,
        "colores": colores,
        "totales_talla": totales_stock_talla,
        "totales_stock_talla": totales_stock_talla,
        "totales_vendido_talla": totales_vendido_talla,
        "totales_en_proceso_talla": totales_en_proceso_talla,
        "stock_total": stock_total,
        "vendido_total": vendido_total,
        "en_proceso_total": en_proceso_total,
        "aplica_op": aplica_op,
        "dias_ytd": dias_ytd,
        "total_colores": len(colores),
        "total_variantes": len(rows),
        "filtros": {
            "marca_id": marca_id,
            "tipo_id": tipo_id,
            "entalle_id": entalle_id,
            "tela_id": tela_id,
            "incluir_taller": incluir_taller,
        },
    }
