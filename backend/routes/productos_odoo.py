"""Productos Odoo con clasificación editable + métricas de ventas.

Similar a produccion/routes/odoo_enriq.py pero enfocado en Ventas:
- Lista productos desde prod_odoo_productos_enriq + métricas YTD (ventas, unidades, tickets)
- Filtra por estado (pendiente/parcial/completo/excluido/todos)
- Permite editar marca, tipo, entalle, tela, tela_general, género, cuello, detalle, lavado
- Aplica filtro de productos excluidos (PALABRAS_EXCLUIDAS de helpers)
"""
import json
from typing import Optional, List
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, VENTA_REAL_WHERE, CLIENTE_SELECT,
    ytd_rango, row_to_dict,
)

router = APIRouter(prefix="/api/productos-odoo")


def _split_csv(s: Optional[str]) -> List[str]:
    """Convierte 'a,b,c' → ['a','b','c'] descartando vacíos. None/'' → []."""
    if not s:
        return []
    return [x.strip() for x in s.split(",") if x.strip()]


class ClasificarInput(BaseModel):
    marca_id: Optional[str] = None
    tipo_id: Optional[str] = None
    tela_general_id: Optional[str] = None
    tela_id: Optional[str] = None
    entalle_id: Optional[str] = None
    genero_id: Optional[str] = None
    cuello_id: Optional[str] = None
    detalle_id: Optional[str] = None
    lavado_id: Optional[str] = None
    notas: Optional[str] = None


def _recalcular_estado(vals: dict, tipo_nombre: Optional[str]) -> tuple:
    required = ['marca_id', 'tipo_id', 'genero_id']
    if tipo_nombre == 'Polo':
        required.append('cuello_id')
    if tipo_nombre in ('Pantalon', 'Short'):
        required.append('lavado_id')
    pendientes = [k for k in required if not vals.get(k)]
    if not pendientes:
        return ('completo', [])
    if any(vals.get(k) for k in ('marca_id', 'tipo_id', 'tela_general_id', 'entalle_id')):
        return ('parcial', pendientes)
    return ('pendiente', pendientes)


@router.get("/stats")
async def stats(_u: dict = Depends(get_current_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT estado, COUNT(*) AS cnt
            FROM produccion.prod_odoo_productos_enriq
            GROUP BY estado
        """)
        by = {r['estado']: r['cnt'] for r in rows}
        return {
            "total": sum(by.values()),
            "pendiente": by.get('pendiente', 0),
            "parcial": by.get('parcial', 0),
            "completo": by.get('completo', 0),
            "excluido": by.get('excluido', 0),
        }


@router.get("")
async def list_productos(
    estado: Optional[str] = Query("todos"),
    q: Optional[str] = None,
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    vista: str = Query("ytd", description="ytd|30|7 para las métricas de venta"),
    anio_compara: Optional[int] = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=500),
    sort_by: str = Query("ventas", pattern="^(ventas|unidades|stock|nombre|estado)$"),
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
    _u: dict = Depends(get_current_user),
):
    pool = await get_pool()
    async with pool.acquire() as conn:
        # 1. Ventas YTD por product_tmpl_id (aplicando filtro de productos prohibidos)
        hoy = datetime.now()
        d, h = ytd_rango(hoy.year, hoy) if vista == "ytd" else ytd_rango(hoy.year, hoy)

        sql_ventas = f"""
        SELECT
            v.product_tmpl_id,
            COALESCE(SUM(v.price_subtotal * 1.18), 0)::numeric(14,2) AS ventas,
            COALESCE(SUM(v.qty), 0)::numeric(14,2) AS unidades,
            COUNT(DISTINCT v.order_id) AS tickets
        {VENTA_REAL_FROM}
        WHERE v.date_order >= $1 AND v.date_order <= $2 AND {VENTA_REAL_WHERE}
        GROUP BY v.product_tmpl_id
        """
        ventas_rows = await conn.fetch(sql_ventas, d, h)
        ventas_map = {r['product_tmpl_id']: row_to_dict(r) for r in ventas_rows}

        # 2. Ventas período anterior para variación
        ventas_ant = {}
        if anio_compara:
            d_a, h_a = ytd_rango(anio_compara, hoy)
            rows_a = await conn.fetch(sql_ventas, d_a, h_a)
            ventas_ant = {r['product_tmpl_id']: row_to_dict(r) for r in rows_a}

        # 3. Filtros sobre la tabla enriq
        conditions = []
        params: list = []
        if estado and estado != 'todos':
            params.append(estado)
            conditions.append(f"p.estado = ${len(params)}")
        if marca_id:
            params.append(marca_id)
            conditions.append(f"p.marca_id = ${len(params)}")
        if tipo_id:
            params.append(tipo_id)
            conditions.append(f"p.tipo_id = ${len(params)}")
        if q and q.strip():
            params.append(f"%{q.strip().lower()}%")
            conditions.append(
                f"(LOWER(p.odoo_nombre) LIKE ${len(params)} OR "
                f"LOWER(p.odoo_marca_texto) LIKE ${len(params)} OR "
                f"LOWER(p.odoo_tipo_texto) LIKE ${len(params)})"
            )
        # Aplicar filtro de productos prohibidos (por nombre)
        conditions.append("""
            p.odoo_template_id NOT IN (
                SELECT odoo_id FROM odoo.product_template
                WHERE name ILIKE ANY (ARRAY['%correa%','%bolsa%','%paneton%','%probador%','%provador%','%saco%','%lapicero%','%publicitario%','%envio%','%envío%'])
            )
        """)
        where = " AND ".join(conditions) if conditions else "TRUE"

        # 4. Contar total
        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM produccion.prod_odoo_productos_enriq p WHERE {where}",
            *params,
        )

        # 5. Listar
        offset = (page - 1) * limit
        sort_expr = {
            "nombre": "p.odoo_nombre",
            "estado": "p.estado",
            "stock": "p.odoo_stock_actual",
        }.get(sort_by)

        order_sql = ""
        if sort_expr:
            direction = "DESC" if sort_dir == "desc" else "ASC"
            order_sql = f"ORDER BY {sort_expr} {direction} NULLS LAST"
        # Si es ventas/unidades: ordenar en Python (después de mergear con ventas_map)

        rows = await conn.fetch(f"""
            SELECT
                p.id, p.odoo_template_id, p.odoo_nombre,
                p.odoo_marca_texto, p.odoo_tipo_texto,
                p.odoo_entalle_texto, p.odoo_tela_texto,
                p.odoo_stock_actual,
                p.estado, p.excluido_motivo,
                p.marca_id, p.tipo_id, p.entalle_id, p.tela_id,
                p.tela_general_id, p.genero_id, p.cuello_id, p.detalle_id, p.lavado_id,
                p.costo_manual, p.campos_pendientes, p.notas,
                p.classified_by, p.classified_at,
                ma.nombre AS marca_nombre,
                ti.nombre AS tipo_nombre,
                en.nombre AS entalle_nombre,
                te.nombre AS tela_nombre,
                tg.nombre AS tela_general_nombre,
                ge.nombre AS genero_nombre,
                cu.nombre AS cuello_nombre,
                de.nombre AS detalle_nombre,
                la.nombre AS lavado_nombre
            FROM produccion.prod_odoo_productos_enriq p
            LEFT JOIN produccion.prod_marcas ma ON ma.id = p.marca_id
            LEFT JOIN produccion.prod_tipos ti ON ti.id = p.tipo_id
            LEFT JOIN produccion.prod_entalles en ON en.id = p.entalle_id
            LEFT JOIN produccion.prod_telas te ON te.id = p.tela_id
            LEFT JOIN produccion.prod_telas_general tg ON tg.id = p.tela_general_id
            LEFT JOIN produccion.prod_generos ge ON ge.id = p.genero_id
            LEFT JOIN produccion.prod_cuellos cu ON cu.id = p.cuello_id
            LEFT JOIN produccion.prod_detalles de ON de.id = p.detalle_id
            LEFT JOIN produccion.prod_lavados la ON la.id = p.lavado_id
            WHERE {where}
            {order_sql}
            LIMIT {limit} OFFSET {offset}
        """, *params)

        items = []
        for r in rows:
            d_row = row_to_dict(r)
            vdata = ventas_map.get(r['odoo_template_id']) or {}
            v_ant = ventas_ant.get(r['odoo_template_id']) or {}
            v_act = float(vdata.get('ventas') or 0)
            v_pre = float(v_ant.get('ventas') or 0)
            d_row['ventas'] = v_act
            d_row['unidades'] = float(vdata.get('unidades') or 0)
            d_row['tickets'] = int(vdata.get('tickets') or 0)
            d_row['var_pct'] = round((v_act - v_pre) / v_pre * 100, 2) if v_pre > 0 else None
            d_row['campos_pendientes'] = r['campos_pendientes'] or []
            items.append(d_row)

        # Si ordenamiento por ventas/unidades, ordenar acá
        if sort_by in ("ventas", "unidades"):
            key = sort_by
            items.sort(key=lambda x: x.get(key) or 0, reverse=(sort_dir == "desc"))

        return {
            "items": items,
            "total": total,
            "page": page,
            "limit": limit,
            "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
        }


def _clasificar_estado(unidades: float, stock: float, dias_cob: Optional[float]) -> str:
    """Devuelve estado del stock según ritmo de ventas y cobertura."""
    if unidades <= 0:
        return 'muerto' if stock > 0 else 'sin_movimiento'
    if stock <= 0:
        return 'sin_stock'
    if dias_cob is not None and dias_cob < 14:
        return 'bajo'
    return 'saludable'


@router.get("/grupos")
async def grupos(
    vista: str = Query("ytd", description="ytd|7|30"),
    anio_compara: Optional[int] = None,
    marca_id: Optional[str] = Query(None, description="UUID(s) de marca, coma-separados ('a,b,c') o uno solo"),
    tipo_id: Optional[str] = Query(None, description="UUID(s) de tipo, coma-separados o uno solo"),
    company_key: Optional[str] = None,
    location_id: Optional[int] = None,
    tienda: Optional[str] = Query(None, description="Nombre(s) de tienda (x_nombre), coma-separados — agrupa múltiples location_id con el mismo nombre"),
    q: Optional[str] = Query(None, description="Búsqueda libre en nombre de modelo (pt.name)"),
    _u: dict = Depends(get_current_user),
):
    """Agrupa ventas YTD por combinación (marca, tipo, entalle, tela).

    Prioriza FKs del catálogo y hace fallback al texto de v_pos_line_full.
    Retorna cada combinación única con métricas agregadas + conteo de productos.
    """
    hoy = datetime.now()
    d, h = ytd_rango(hoy.year, hoy)

    pool = await get_pool()
    async with pool.acquire() as conn:
        # Construir query de agrupación: usa FK si existe, sino texto
        async def _query_grupos(desde, hasta):
            params: list = [desde, hasta]
            where_extra = [VENTA_REAL_WHERE]
            if company_key and company_key != "all":
                params.append(company_key)
                where_extra.append(f"v.company_key = ${len(params)}")
            if location_id:
                params.append(location_id)
                where_extra.append(f"po.location_id = ${len(params)}")
            tiendas_list = _split_csv(tienda)
            if tiendas_list:
                params.append(tiendas_list)
                # Filtra location_id por x_nombre del stock_location (consolida TALLER etc.)
                where_extra.append(
                    f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ANY(${len(params)}::text[]))"
                )
            marcas_list = _split_csv(marca_id)
            if marcas_list:
                params.append(marcas_list)
                where_extra.append(f"pe.marca_id = ANY(${len(params)}::text[])")
            tipos_list = _split_csv(tipo_id)
            if tipos_list:
                params.append(tipos_list)
                where_extra.append(f"pe.tipo_id = ANY(${len(params)}::text[])")
            if q and q.strip():
                # Buscar por modelo, marca, tipo, entalle o tela del product_template
                params.append(f"%{q.strip()}%")
                idx = len(params)
                where_extra.append(
                    f"v.product_tmpl_id IN ("
                    f"SELECT odoo_id FROM odoo.product_template "
                    f"WHERE name ILIKE ${idx} OR marca ILIKE ${idx} "
                    f"   OR tipo ILIKE ${idx} OR entalle ILIKE ${idx} OR tela ILIKE ${idx}"
                    f")"
                )

            where_sql = " AND ".join(["v.date_order >= $1", "v.date_order <= $2"] + where_extra)

            # Lógica de clasificación con auto-match:
            # 1) Si hay FK en prod_odoo_productos_enriq → usar ID del catálogo (nombre bonito)
            # 2) Si NO hay FK pero el texto de product_template coincide case-insensitive
            #    con algún catálogo → resolver al ID del catálogo (auto-match)
            # 3) Si el texto NO matchea ningún catálogo → usar 't:TEXTO' como fallback
            # 4) Si no hay ni FK ni texto → NULL (Sin clasificar)
            sql = f"""
            WITH lineas AS (
                SELECT
                    v.order_id,
                    v.qty,
                    v.price_subtotal,
                    v.product_tmpl_id,
                    {CLIENTE_SELECT} AS cliente_id,
                    -- Auto-match: si no hay FK, intentar matchear el texto del template con el catálogo
                    COALESCE(pe.marca_id::text, ma_auto.id::text,
                             CASE WHEN pt.marca <> '' THEN 't:' || pt.marca END) AS grp_marca,
                    COALESCE(pe.tipo_id::text, ti_auto.id::text,
                             CASE WHEN pt.tipo <> '' THEN 't:' || pt.tipo END) AS grp_tipo,
                    COALESCE(pe.entalle_id::text, en_auto.id::text,
                             CASE WHEN pt.entalle <> '' THEN 't:' || pt.entalle END) AS grp_entalle,
                    COALESCE(pe.tela_id::text, te_auto.id::text,
                             CASE WHEN pt.tela <> '' THEN 't:' || pt.tela END) AS grp_tela,
                    COALESCE(ma.nombre, ma_auto.nombre, pt.marca) AS label_marca,
                    COALESCE(ti.nombre, ti_auto.nombre, pt.tipo) AS label_tipo,
                    COALESCE(en.nombre, en_auto.nombre, pt.entalle) AS label_entalle,
                    COALESCE(te.nombre, te_auto.nombre, pt.tela) AS label_tela
                {VENTA_REAL_FROM}
                LEFT JOIN odoo.product_template pt ON pt.odoo_id = v.product_tmpl_id
                LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id
                LEFT JOIN produccion.prod_marcas ma ON ma.id = pe.marca_id
                LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
                LEFT JOIN produccion.prod_entalles en ON en.id = pe.entalle_id
                LEFT JOIN produccion.prod_telas te ON te.id = pe.tela_id
                -- Auto-match por nombre normalizado (solo si no hay FK)
                LEFT JOIN produccion.prod_marcas ma_auto
                    ON pe.marca_id IS NULL
                    AND pt.marca IS NOT NULL AND pt.marca <> ''
                    AND LOWER(TRIM(ma_auto.nombre)) = LOWER(TRIM(pt.marca))
                LEFT JOIN produccion.prod_tipos ti_auto
                    ON pe.tipo_id IS NULL
                    AND pt.tipo IS NOT NULL AND pt.tipo <> ''
                    AND LOWER(TRIM(ti_auto.nombre)) = LOWER(TRIM(pt.tipo))
                LEFT JOIN produccion.prod_entalles en_auto
                    ON pe.entalle_id IS NULL
                    AND pt.entalle IS NOT NULL AND pt.entalle <> ''
                    AND LOWER(TRIM(en_auto.nombre)) = LOWER(TRIM(pt.entalle))
                LEFT JOIN produccion.prod_telas te_auto
                    ON pe.tela_id IS NULL
                    AND pt.tela IS NOT NULL AND pt.tela <> ''
                    AND LOWER(TRIM(te_auto.nombre)) = LOWER(TRIM(pt.tela))
                WHERE {where_sql}
            )
            SELECT
                grp_marca, grp_tipo, grp_entalle, grp_tela,
                MAX(label_marca) AS label_marca,
                MAX(label_tipo) AS label_tipo,
                MAX(label_entalle) AS label_entalle,
                MAX(label_tela) AS label_tela,
                COALESCE(SUM(price_subtotal * 1.18), 0)::numeric(14,2) AS ventas,
                COALESCE(SUM(qty), 0)::numeric(14,2) AS unidades,
                COUNT(DISTINCT order_id) AS tickets,
                COUNT(DISTINCT cliente_id) AS clientes_unicos,
                COUNT(DISTINCT product_tmpl_id) AS productos
            FROM lineas
            GROUP BY grp_marca, grp_tipo, grp_entalle, grp_tela
            ORDER BY ventas DESC;
            """
            return await conn.fetch(sql, *params)

        rows = await _query_grupos(d, h)

        # Comparativo
        ant_map = {}
        if anio_compara:
            d_a, h_a = ytd_rango(anio_compara, hoy)
            rows_a = await _query_grupos(d_a, h_a)
            for r in rows_a:
                key = (r['grp_marca'], r['grp_tipo'], r['grp_entalle'], r['grp_tela'])
                ant_map[key] = float(r['ventas'])

        # ============ STOCK por combinación ============
        # Calcula stock actual por (marca, tipo, entalle, tela) respetando filtro tienda.
        stock_params: list = []
        stock_where_loc = ""
        stock_tiendas_list = _split_csv(tienda)
        if stock_tiendas_list:
            stock_params.append(stock_tiendas_list)
            stock_where_loc = f"""AND q.location_id IN (
                SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ANY(${len(stock_params)}::text[])
            )"""
        elif location_id:
            stock_params.append(location_id)
            stock_where_loc = f"AND q.location_id = ${len(stock_params)}"
        else:
            # Sin filtro: solo locations internas (no customer/vendor/virtual)
            stock_where_loc = """AND q.location_id IN (
                SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true
            )"""

        sql_stock = f"""
        WITH stock_por_tmpl AS (
            SELECT pp.product_tmpl_id, SUM(q.qty)::numeric(14,2) AS stock
            FROM odoo.stock_quant q
            JOIN odoo.product_product pp ON pp.odoo_id = q.product_id
            WHERE 1=1 {stock_where_loc}
            GROUP BY pp.product_tmpl_id
        )
        SELECT
            -- Mismo auto-match que en ventas para consistencia
            COALESCE(pe.marca_id::text, ma_auto.id::text,
                     CASE WHEN pt.marca <> '' THEN 't:' || pt.marca END) AS grp_marca,
            COALESCE(pe.tipo_id::text, ti_auto.id::text,
                     CASE WHEN pt.tipo <> '' THEN 't:' || pt.tipo END) AS grp_tipo,
            COALESCE(pe.entalle_id::text, en_auto.id::text,
                     CASE WHEN pt.entalle <> '' THEN 't:' || pt.entalle END) AS grp_entalle,
            COALESCE(pe.tela_id::text, te_auto.id::text,
                     CASE WHEN pt.tela <> '' THEN 't:' || pt.tela END) AS grp_tela,
            SUM(st.stock)::numeric(14,2) AS stock
        FROM odoo.product_template pt
        JOIN stock_por_tmpl st ON st.product_tmpl_id = pt.odoo_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
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
        WHERE st.stock > 0
        GROUP BY 1, 2, 3, 4;
        """
        stock_rows = await conn.fetch(sql_stock, *stock_params)
        stock_map = {
            (r['grp_marca'], r['grp_tipo'], r['grp_entalle'], r['grp_tela']): float(r['stock'])
            for r in stock_rows
        }
        # Días transcurridos del período (para calcular ritmo diario)
        dias_transcurridos = max(1, (h.date() - d.date()).days + 1)

        total_ventas = sum(float(r['ventas']) for r in rows)

        items = []
        acumulado = 0.0
        for r in rows:
            key = (r['grp_marca'], r['grp_tipo'], r['grp_entalle'], r['grp_tela'])
            ventas = float(r['ventas'])
            unidades = float(r['unidades'])
            acumulado += ventas
            v_ant = ant_map.get(key, 0)
            var_pct = round((ventas - v_ant) / v_ant * 100, 2) if v_ant > 0 else None

            # Stock + cobertura
            stock = stock_map.get(key, 0.0)
            ritmo_diario = round(unidades / dias_transcurridos, 2) if unidades > 0 else 0
            dias_cob = round(stock / ritmo_diario, 1) if ritmo_diario > 0 else None
            estado = _clasificar_estado(unidades, stock, dias_cob)

            items.append({
                "key": "|".join([k or "" for k in key]),
                "marca_id": r['grp_marca'],
                "tipo_id": r['grp_tipo'],
                "entalle_id": r['grp_entalle'],
                "tela_id": r['grp_tela'],
                "marca": r['label_marca'] or "Sin clasificar",
                "tipo": r['label_tipo'] or "Sin clasificar",
                "entalle": r['label_entalle'] or "Sin clasificar",
                "tela": r['label_tela'] or "Sin clasificar",
                "ventas": round(ventas, 2),
                "unidades": unidades,
                "tickets": int(r['tickets']),
                "clientes_unicos": int(r['clientes_unicos']),
                "productos": int(r['productos']),
                "share_pct": round(ventas / total_ventas * 100, 2) if total_ventas > 0 else 0,
                "acumulado_pct": round(acumulado / total_ventas * 100, 2) if total_ventas > 0 else 0,
                "var_pct": var_pct,
                "stock": stock,
                "venta_diaria": ritmo_diario,
                "dias_cobertura": dias_cob,
                "estado_stock": estado,
            })


        return {
            "items": items,
            "total_ventas": round(total_ventas, 2),
            "total_grupos": len(items),
            "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
            "anio_compara": anio_compara,
        }


@router.get("/grupo-color-talla")
async def grupo_color_talla(
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    entalle_id: Optional[str] = None,
    tela_id: Optional[str] = None,
    tienda: Optional[str] = Query(None, description="Nombre(s) de tienda (x_nombre), coma-separados o uno solo"),
    _u: dict = Depends(get_current_user),
):
    """Pivot color × talla con unidades vendidas YTD 2026 + stock actual.

    Para un grupo (marca, tipo, entalle, tela) específico, agrupa las ventas
    por color (filas) y talla (columnas). También incluye stock actual por
    cada par color/talla para ver cobertura puntual.
    """
    hoy = datetime.now()
    d, h = ytd_rango(hoy.year, hoy)

    pool = await get_pool()
    async with pool.acquire() as conn:
        # ===== Filtros del grupo =====
        ventas_filtros = [VENTA_REAL_WHERE]
        ventas_params: list = [d, h]

        # Helper: para filtrar el grupo en ventas y stock
        # Cada dimensión puede ser FK uuid, "t:TEXTO", o vacía (ya viene como "Sin clasificar")
        def filtro_dim(val: Optional[str], pe_col: str, pt_col: str, ma_auto_col: Optional[str] = None):
            """Devuelve cláusula SQL para filtrar por la dimensión.

            En Pareto los IDs vienen como UUID o 't:TEXTO'. El UUID puede ser:
              a) FK directo en pe.X_id
              b) Auto-match: pe.X_id IS NULL pero pt.X matchea con catálogo cuyo id == val
            """
            if not val:
                return None, None
            if val.startswith("t:"):
                texto = val[2:]
                return (f"(pe.{pe_col} IS NULL AND LOWER(TRIM(pt.{pt_col})) = LOWER(TRIM($PARAM)))", texto)
            # FK: puede ser asignado o auto-match
            return (f"(pe.{pe_col} = $PARAM OR (pe.{pe_col} IS NULL AND LOWER(TRIM(pt.{pt_col})) IN (SELECT LOWER(TRIM(nombre)) FROM {ma_auto_col} WHERE id = $PARAM)))", val)

        ma_auto_tables = {
            'marca_id': 'produccion.prod_marcas',
            'tipo_id': 'produccion.prod_tipos',
            'entalle_id': 'produccion.prod_entalles',
            'tela_id': 'produccion.prod_telas',
        }
        pt_cols = {
            'marca_id': 'marca',
            'tipo_id': 'tipo',
            'entalle_id': 'entalle',
            'tela_id': 'tela',
        }
        # Aplicar filtros de grupo
        for fk, val in [('marca_id', marca_id), ('tipo_id', tipo_id),
                        ('entalle_id', entalle_id), ('tela_id', tela_id)]:
            if val is None:
                continue
            if val.startswith("t:"):
                texto = val[2:]
                ventas_params.append(texto)
                # Para tipo, considerar también primera palabra (Pantalon Denim → Pantalon)
                if fk == 'tipo_id':
                    ventas_filtros.append(
                        f"pe.{fk} IS NULL AND (LOWER(TRIM(pt.{pt_cols[fk]})) = LOWER(TRIM(${len(ventas_params)})) "
                        f"OR LOWER(TRIM(SPLIT_PART(pt.{pt_cols[fk]}, ' ', 1))) = LOWER(TRIM(${len(ventas_params)})))"
                    )
                else:
                    ventas_filtros.append(
                        f"pe.{fk} IS NULL AND LOWER(TRIM(pt.{pt_cols[fk]})) = LOWER(TRIM(${len(ventas_params)}))"
                    )
            else:
                ventas_params.append(val)
                idx = len(ventas_params)
                ventas_filtros.append(
                    f"(pe.{fk} = ${idx} OR (pe.{fk} IS NULL "
                    f"AND LOWER(TRIM(pt.{pt_cols[fk]})) IN "
                    f"(SELECT LOWER(TRIM(nombre)) FROM {ma_auto_tables[fk]} WHERE id = ${idx})))"
                )

        # Filtro de tienda (opcional, acepta CSV)
        loc_filter = ""
        tiendas_list = _split_csv(tienda)
        if tiendas_list:
            ventas_params.append(tiendas_list)
            ventas_filtros.append(
                f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ANY(${len(ventas_params)}::text[]))"
            )

        ventas_where = " AND ".join(["v.date_order >= $1", "v.date_order <= $2"] + ventas_filtros)

        # ===== Query: ventas YTD por color y talla =====
        sql_ventas = f"""
        SELECT
            COALESCE(NULLIF(v.color, ''), '— sin color —') AS color,
            COALESCE(NULLIF(v.talla, ''), '—') AS talla,
            COALESCE(SUM(v.qty), 0)::numeric(14,0) AS unidades,
            COALESCE(SUM(v.price_subtotal * 1.18), 0)::numeric(14,2) AS ventas
        {VENTA_REAL_FROM}
        LEFT JOIN odoo.product_template pt ON pt.odoo_id = v.product_tmpl_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id
        WHERE {ventas_where}
        GROUP BY 1, 2
        HAVING SUM(v.qty) > 0
        ORDER BY 1, 2;
        """
        ventas_rows = await conn.fetch(sql_ventas, *ventas_params)

        # ===== Query: stock actual por color y talla (mismo grupo, misma tienda si aplica) =====
        stock_filtros = []
        stock_params: list = []
        for fk, val in [('marca_id', marca_id), ('tipo_id', tipo_id),
                        ('entalle_id', entalle_id), ('tela_id', tela_id)]:
            if val is None:
                continue
            if val.startswith("t:"):
                texto = val[2:]
                stock_params.append(texto)
                if fk == 'tipo_id':
                    stock_filtros.append(
                        f"pe.{fk} IS NULL AND (LOWER(TRIM(pt.{pt_cols[fk]})) = LOWER(TRIM(${len(stock_params)})) "
                        f"OR LOWER(TRIM(SPLIT_PART(pt.{pt_cols[fk]}, ' ', 1))) = LOWER(TRIM(${len(stock_params)})))"
                    )
                else:
                    stock_filtros.append(
                        f"pe.{fk} IS NULL AND LOWER(TRIM(pt.{pt_cols[fk]})) = LOWER(TRIM(${len(stock_params)}))"
                    )
            else:
                stock_params.append(val)
                idx = len(stock_params)
                stock_filtros.append(
                    f"(pe.{fk} = ${idx} OR (pe.{fk} IS NULL "
                    f"AND LOWER(TRIM(pt.{pt_cols[fk]})) IN "
                    f"(SELECT LOWER(TRIM(nombre)) FROM {ma_auto_tables[fk]} WHERE id = ${idx})))"
                )
        stock_loc_clause = ""
        if tiendas_list:
            stock_params.append(tiendas_list)
            stock_loc_clause = f"AND q.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ANY(${len(stock_params)}::text[]))"
        else:
            stock_loc_clause = "AND q.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage='internal' AND active=true)"

        stock_where = " AND ".join(stock_filtros) if stock_filtros else "TRUE"

        sql_stock = f"""
        SELECT
            COALESCE(NULLIF(vf.color, ''), '— sin color —') AS color,
            COALESCE(NULLIF(vf.talla, ''), '—') AS talla,
            COALESCE(SUM(q.qty), 0)::numeric(14,0) AS stock
        FROM odoo.stock_quant q
        JOIN odoo.product_product pp ON pp.odoo_id = q.product_id
        JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id
        JOIN odoo.v_product_variant_flat vf ON vf.product_product_id = pp.odoo_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        WHERE q.qty > 0 {stock_loc_clause}
          AND ({stock_where})
        GROUP BY 1, 2
        HAVING SUM(q.qty) > 0;
        """
        stock_rows = await conn.fetch(sql_stock, *stock_params)
        stock_map = {(r['color'], r['talla']): float(r['stock']) for r in stock_rows}

        # ===== Stock por TIENDA (para tooltip de otras ubicaciones) =====
        # Misma query del grupo pero agrupado por x_nombre. NO aplica filtro de tienda.
        otras_params: list = []
        otras_filtros = []
        for fk, val in [('marca_id', marca_id), ('tipo_id', tipo_id),
                        ('entalle_id', entalle_id), ('tela_id', tela_id)]:
            if val is None:
                continue
            if val.startswith("t:"):
                texto = val[2:]
                otras_params.append(texto)
                if fk == 'tipo_id':
                    otras_filtros.append(
                        f"pe.{fk} IS NULL AND (LOWER(TRIM(pt.{pt_cols[fk]})) = LOWER(TRIM(${len(otras_params)})) "
                        f"OR LOWER(TRIM(SPLIT_PART(pt.{pt_cols[fk]}, ' ', 1))) = LOWER(TRIM(${len(otras_params)})))"
                    )
                else:
                    otras_filtros.append(
                        f"pe.{fk} IS NULL AND LOWER(TRIM(pt.{pt_cols[fk]})) = LOWER(TRIM(${len(otras_params)}))"
                    )
            else:
                otras_params.append(val)
                idx = len(otras_params)
                otras_filtros.append(
                    f"(pe.{fk} = ${idx} OR (pe.{fk} IS NULL "
                    f"AND LOWER(TRIM(pt.{pt_cols[fk]})) IN "
                    f"(SELECT LOWER(TRIM(nombre)) FROM {ma_auto_tables[fk]} WHERE id = ${idx})))"
                )
        otras_where = " AND ".join(otras_filtros) if otras_filtros else "TRUE"

        sql_otras = f"""
        SELECT
            sl.x_nombre AS tienda,
            COALESCE(NULLIF(vf.color, ''), '— sin color —') AS color,
            COALESCE(NULLIF(vf.talla, ''), '—') AS talla,
            COALESCE(SUM(q.qty), 0)::numeric(14,0) AS stock
        FROM odoo.stock_quant q
        JOIN odoo.product_product pp ON pp.odoo_id = q.product_id
        JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id
        JOIN odoo.v_product_variant_flat vf ON vf.product_product_id = pp.odoo_id
        JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        WHERE q.qty > 0
          AND sl.usage = 'internal' AND sl.active = true
          AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
          AND ({otras_where})
        GROUP BY 1, 2, 3
        HAVING SUM(q.qty) > 0;
        """
        otras_rows = await conn.fetch(sql_otras, *otras_params)
        # otras_por_celda[(color, talla)] = {tienda: stock}
        otras_por_celda = {}
        for r in otras_rows:
            key = (r['color'], r['talla'])
            otras_por_celda.setdefault(key, {})[r['tienda']] = float(r['stock'])

        # ===== Modelos (templates) por celda con detalle de ubicación =====
        # Para identificar modelos "nuevos" (solo en TALLER/AP, sin presencia en tiendas)
        sql_modelos = f"""
        SELECT
            pt.odoo_id AS tmpl_id,
            pt.name AS modelo,
            COALESCE(NULLIF(vf.color, ''), '— sin color —') AS color,
            COALESCE(NULLIF(vf.talla, ''), '—') AS talla,
            sl.x_nombre AS tienda,
            COALESCE(SUM(q.qty), 0)::numeric(14,0) AS stock
        FROM odoo.stock_quant q
        JOIN odoo.product_product pp ON pp.odoo_id = q.product_id
        JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id
        JOIN odoo.v_product_variant_flat vf ON vf.product_product_id = pp.odoo_id
        JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        WHERE q.qty > 0
          AND sl.usage = 'internal' AND sl.active = true
          AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
          AND ({otras_where})
        GROUP BY 1, 2, 3, 4, 5
        HAVING SUM(q.qty) > 0;
        """
        modelos_rows = await conn.fetch(sql_modelos, *otras_params)
        # modelos_por_celda[(color, talla)] = [{tmpl_id, modelo, ubicaciones: {tienda: stock}, total, es_nuevo}]
        modelos_acum = {}  # {(color, talla, tmpl_id): {modelo, ubicaciones, total}}
        for r in modelos_rows:
            ckey = (r['color'], r['talla'], r['tmpl_id'])
            if ckey not in modelos_acum:
                modelos_acum[ckey] = {
                    "tmpl_id": r['tmpl_id'],
                    "modelo": r['modelo'],
                    "ubicaciones": {},
                    "total": 0,
                }
            modelos_acum[ckey]["ubicaciones"][r['tienda']] = float(r['stock'])
            modelos_acum[ckey]["total"] += float(r['stock'])

        # ===== Última venta por modelo (en la tienda activa o global) =====
        # Útil para detectar stock muerto: tiene stock pero hace meses no se vende.
        tmpl_ids_con_stock = {info["tmpl_id"] for info in modelos_acum.values()}
        ultimas_ventas = {}  # {tmpl_id: 'YYYY-MM-DD' o None}
        if tmpl_ids_con_stock:
            uv_params: list = [list(tmpl_ids_con_stock)]
            uv_where = ["v.product_tmpl_id = ANY($1::int[])", VENTA_REAL_WHERE]
            if tiendas_list:
                uv_params.append(tiendas_list)
                uv_where.append(
                    f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ANY(${len(uv_params)}::text[]))"
                )
            uv_sql = f"""
            SELECT
                v.product_tmpl_id AS tmpl_id,
                (MAX(v.date_order) AT TIME ZONE 'America/Lima')::date AS ultima_venta
            {VENTA_REAL_FROM}
            WHERE {' AND '.join(uv_where)}
            GROUP BY 1;
            """
            uv_rows = await conn.fetch(uv_sql, *uv_params)
            for r in uv_rows:
                ultimas_ventas[int(r['tmpl_id'])] = (
                    r['ultima_venta'].isoformat() if r['ultima_venta'] else None
                )

        # Definir TIENDAS_ALMACEN (no son tiendas comerciales)
        TIENDAS_ALMACEN = {'TALLER', 'AP'}

        modelos_por_celda = {}
        for (color, talla, tmpl_id), info in modelos_acum.items():
            ubic = info["ubicaciones"]
            tiendas_con_stock = set(ubic.keys())
            tiendas_comerciales = tiendas_con_stock - TIENDAS_ALMACEN
            # "Nuevo": todo su stock está en almacenes (TALLER/AP), nada en tiendas comerciales
            es_nuevo = len(tiendas_comerciales) == 0 and len(tiendas_con_stock & TIENDAS_ALMACEN) > 0
            entry = {
                "tmpl_id": info["tmpl_id"],
                "modelo": info["modelo"],
                "ubicaciones": ubic,
                "total": info["total"],
                "es_nuevo": es_nuevo,
                "ultima_venta": ultimas_ventas.get(int(info["tmpl_id"])),
            }
            modelos_por_celda.setdefault((color, talla), []).append(entry)
        # Ordenar modelos por total desc
        for k in modelos_por_celda:
            modelos_por_celda[k].sort(key=lambda x: -x["total"])

        # ===== Construir pivot =====
        # Tallas únicas (ordenar)
        all_tallas = sorted(set([r['talla'] for r in ventas_rows] + [r['talla'] for r in stock_rows]))
        numericas = sorted([t for t in all_tallas if t.replace('.', '').isdigit()], key=lambda x: float(x))
        alfa = [t for t in all_tallas if not t.replace('.', '').isdigit()]
        orden_alfa = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'U', 'STD', '—']
        alfa_sorted = sorted(alfa, key=lambda x: (orden_alfa.index(x) if x in orden_alfa else 99, x))
        tallas = numericas + alfa_sorted

        colores_map = {}
        for r in ventas_rows:
            c = r['color']
            t = r['talla']
            if c not in colores_map:
                colores_map[c] = {
                    "color": c,
                    "ventas_total": 0,
                    "unidades_total": 0,
                    "stock_total": 0,
                    "tallas_ventas": {},
                    "tallas_stock": {},
                    "tallas_otras": {},  # {talla: {tienda: stock}}
                }
            colores_map[c]["unidades_total"] += float(r['unidades'])
            colores_map[c]["ventas_total"] += float(r['ventas'])
            colores_map[c]["tallas_ventas"][t] = float(r['unidades'])
        # Agregar stock
        for (c, t), st in stock_map.items():
            if c not in colores_map:
                colores_map[c] = {
                    "color": c,
                    "ventas_total": 0, "unidades_total": 0, "stock_total": 0,
                    "tallas_ventas": {}, "tallas_stock": {},
                    "tallas_otras": {},
                }
            colores_map[c]["tallas_stock"][t] = st
            colores_map[c]["stock_total"] += st
        # Agregar stock de otras tiendas
        for (c, t), por_tienda in otras_por_celda.items():
            if c not in colores_map:
                colores_map[c] = {
                    "color": c,
                    "ventas_total": 0, "unidades_total": 0, "stock_total": 0,
                    "tallas_ventas": {}, "tallas_stock": {},
                    "tallas_otras": {}, "tallas_modelos": {},
                }
            else:
                colores_map[c].setdefault("tallas_modelos", {})
            colores_map[c]["tallas_otras"][t] = por_tienda
        # Agregar modelos por celda
        for (c, t), modelos in modelos_por_celda.items():
            if c not in colores_map:
                colores_map[c] = {
                    "color": c,
                    "ventas_total": 0, "unidades_total": 0, "stock_total": 0,
                    "tallas_ventas": {}, "tallas_stock": {},
                    "tallas_otras": {}, "tallas_modelos": {},
                }
            else:
                colores_map[c].setdefault("tallas_modelos", {})
            colores_map[c]["tallas_modelos"][t] = modelos

        colores = list(colores_map.values())
        colores.sort(key=lambda x: -x["unidades_total"])

        return {
            "tallas": tallas,
            "colores": colores,
            "total_colores": len(colores),
            "periodo": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
        }


@router.get("/grupo-ventas-detalle")
async def grupo_ventas_detalle(
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    entalle_id: Optional[str] = None,
    tela_id: Optional[str] = None,
    tienda: Optional[str] = Query(None, description="Nombre(s) de tienda (x_nombre), coma-separados o uno solo"),
    _u: dict = Depends(get_current_user),
):
    """Desglose de ventas YTD por modelo + color + talla para un grupo.

    Mismo filtro que /grupo-color-talla pero retorna lista plana con cada
    combinación (modelo, color, talla) y sus unidades/soles. Sirve para mostrar
    "qué se vendió" al hacer clic en la celda de unidades del Pareto.
    """
    hoy = datetime.now()
    d, h = ytd_rango(hoy.year, hoy)

    pool = await get_pool()
    async with pool.acquire() as conn:
        ventas_filtros = [VENTA_REAL_WHERE]
        ventas_params: list = [d, h]

        ma_auto_tables = {
            'marca_id': 'produccion.prod_marcas',
            'tipo_id': 'produccion.prod_tipos',
            'entalle_id': 'produccion.prod_entalles',
            'tela_id': 'produccion.prod_telas',
        }
        pt_cols = {
            'marca_id': 'marca',
            'tipo_id': 'tipo',
            'entalle_id': 'entalle',
            'tela_id': 'tela',
        }
        for fk, val in [('marca_id', marca_id), ('tipo_id', tipo_id),
                        ('entalle_id', entalle_id), ('tela_id', tela_id)]:
            if val is None:
                continue
            if val.startswith("t:"):
                texto = val[2:]
                ventas_params.append(texto)
                if fk == 'tipo_id':
                    ventas_filtros.append(
                        f"pe.{fk} IS NULL AND (LOWER(TRIM(pt.{pt_cols[fk]})) = LOWER(TRIM(${len(ventas_params)})) "
                        f"OR LOWER(TRIM(SPLIT_PART(pt.{pt_cols[fk]}, ' ', 1))) = LOWER(TRIM(${len(ventas_params)})))"
                    )
                else:
                    ventas_filtros.append(
                        f"pe.{fk} IS NULL AND LOWER(TRIM(pt.{pt_cols[fk]})) = LOWER(TRIM(${len(ventas_params)}))"
                    )
            else:
                ventas_params.append(val)
                idx = len(ventas_params)
                ventas_filtros.append(
                    f"(pe.{fk} = ${idx} OR (pe.{fk} IS NULL "
                    f"AND LOWER(TRIM(pt.{pt_cols[fk]})) IN "
                    f"(SELECT LOWER(TRIM(nombre)) FROM {ma_auto_tables[fk]} WHERE id = ${idx})))"
                )

        tiendas_list = _split_csv(tienda)
        if tiendas_list:
            ventas_params.append(tiendas_list)
            ventas_filtros.append(
                f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ANY(${len(ventas_params)}::text[]))"
            )

        ventas_where = " AND ".join(["v.date_order >= $1", "v.date_order <= $2"] + ventas_filtros)

        sql = f"""
        SELECT
            v.product_tmpl_id AS tmpl_id,
            COALESCE(NULLIF(pt.name, ''), '— sin modelo —') AS modelo,
            COALESCE(NULLIF(v.color, ''), '— sin color —') AS color,
            COALESCE(NULLIF(v.talla, ''), '—') AS talla,
            SUM(v.qty)::numeric(14,0) AS unidades,
            SUM(v.price_subtotal * 1.18)::numeric(14,2) AS ventas,
            COUNT(DISTINCT v.order_id) AS tickets,
            (MIN(v.date_order) AT TIME ZONE 'America/Lima')::date AS primera_venta,
            (MAX(v.date_order) AT TIME ZONE 'America/Lima')::date AS ultima_venta
        {VENTA_REAL_FROM}
        LEFT JOIN odoo.product_template pt ON pt.odoo_id = v.product_tmpl_id
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id
        WHERE {ventas_where}
        GROUP BY 1, 2, 3, 4
        HAVING SUM(v.qty) > 0
        ORDER BY 5 DESC, 2, 3, 4;
        """
        rows = await conn.fetch(sql, *ventas_params)

        items = [{
            "tmpl_id": int(r["tmpl_id"]) if r["tmpl_id"] else None,
            "modelo": r["modelo"],
            "color": r["color"],
            "talla": r["talla"],
            "unidades": float(r["unidades"]),
            "ventas": float(r["ventas"]),
            "tickets": int(r["tickets"]),
            "primera_venta": r["primera_venta"].isoformat() if r["primera_venta"] else None,
            "ultima_venta": r["ultima_venta"].isoformat() if r["ultima_venta"] else None,
        } for r in rows]

        return {
            "items": items,
            "total_unidades": sum(it["unidades"] for it in items),
            "total_ventas": sum(it["ventas"] for it in items),
            "total_lineas": len(items),
            "periodo": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
            "tienda": tienda,
        }


@router.get("/grupo-modelo-timeline")
async def grupo_modelo_timeline(
    tmpl_id: int = Query(..., description="odoo_id del product_template"),
    tienda: Optional[str] = Query(None, description="Nombre(s) de tienda (x_nombre), coma-separados o uno solo"),
    meses: int = Query(18, ge=1, le=60, description="Cuántos meses hacia atrás (1-60)"),
    _u: dict = Depends(get_current_user),
):
    """Timeline diario de ventas para un modelo específico.

    Devuelve serie por día (con relleno opcional de días sin venta para gráfico
    continuo). Sirve para ver:
    - Si las ventas son estacionales / esporádicas
    - Si está vendiendo poco a poco con stock alto (problema de rotación)
    """
    pool = await get_pool()
    desde_dt = datetime.now() - timedelta(days=meses * 30)

    async with pool.acquire() as conn:
        params: list = [tmpl_id, desde_dt]
        where = [
            "v.product_tmpl_id = $1",
            "v.date_order >= $2",
            VENTA_REAL_WHERE,
        ]
        tiendas_list = _split_csv(tienda)
        if tiendas_list:
            params.append(tiendas_list)
            where.append(
                f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ANY(${len(params)}::text[]))"
            )
        where_sql = " AND ".join(where)

        sql = f"""
        SELECT
            (v.date_order AT TIME ZONE 'America/Lima')::date AS dia,
            SUM(v.qty)::int AS unidades,
            SUM(v.price_subtotal * 1.18)::numeric(14,2) AS ventas,
            COUNT(DISTINCT v.order_id) AS tickets
        {VENTA_REAL_FROM}
        WHERE {where_sql}
        GROUP BY 1
        HAVING SUM(v.qty) <> 0
        ORDER BY 1;
        """
        rows = await conn.fetch(sql, *params)

        # También: nombre del modelo y stock actual por tienda (referencia)
        info_sql = """
        SELECT pt.name AS modelo, pt.marca, pt.tipo, pt.entalle, pt.tela
        FROM odoo.product_template pt
        WHERE pt.odoo_id = $1
        LIMIT 1;
        """
        info_row = await conn.fetchrow(info_sql, tmpl_id)

        stock_actual_sql = """
        SELECT
            sl.x_nombre AS tienda,
            COALESCE(SUM(q.qty), 0)::int AS stock
        FROM odoo.stock_quant q
        JOIN odoo.product_product pp ON pp.odoo_id = q.product_id
        JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
        WHERE pp.product_tmpl_id = $1
          AND sl.usage = 'internal' AND sl.active = true
          AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
        GROUP BY 1
        HAVING SUM(q.qty) > 0
        ORDER BY 2 DESC;
        """
        stock_rows = await conn.fetch(stock_actual_sql, tmpl_id)

        serie = [{
            "dia": r["dia"].isoformat(),
            "unidades": int(r["unidades"]),
            "ventas": float(r["ventas"]),
            "tickets": int(r["tickets"]),
        } for r in rows]

        total_unidades = sum(s["unidades"] for s in serie)
        total_ventas = sum(s["ventas"] for s in serie)
        stock_total = sum(int(r["stock"]) for r in stock_rows)
        # "Días de cobertura" rough: stock / venta_diaria_promedio
        dias_serie = max((datetime.now().date() - desde_dt.date()).days, 1)
        venta_diaria = total_unidades / dias_serie if dias_serie > 0 else 0
        dias_cobertura = (stock_total / venta_diaria) if venta_diaria > 0 else None

        return {
            "tmpl_id": tmpl_id,
            "modelo": info_row["modelo"] if info_row else None,
            "marca": info_row["marca"] if info_row else None,
            "tipo": info_row["tipo"] if info_row else None,
            "entalle": info_row["entalle"] if info_row else None,
            "tela": info_row["tela"] if info_row else None,
            "tienda_filtro": tienda,
            "periodo_meses": meses,
            "desde": desde_dt.date().isoformat(),
            "serie": serie,
            "total_unidades": total_unidades,
            "total_ventas": round(total_ventas, 2),
            "stock_actual": stock_total,
            "stock_por_tienda": [{"tienda": r["tienda"], "stock": int(r["stock"])} for r in stock_rows],
            "venta_diaria_promedio": round(venta_diaria, 2),
            "dias_cobertura": round(dias_cobertura, 0) if dias_cobertura is not None else None,
        }


@router.get("/grupo-detalle")
async def grupo_detalle(
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    entalle_id: Optional[str] = None,
    tela_id: Optional[str] = None,
    _u: dict = Depends(get_current_user),
):
    """Devuelve los productos individuales que componen un grupo específico,
    con sus ventas YTD 2026 y su clasificación actual."""
    hoy = datetime.now()
    d, h = ytd_rango(hoy.year, hoy)

    pool = await get_pool()
    async with pool.acquire() as conn:
        params: list = [d, h]
        filtros = [VENTA_REAL_WHERE]

        def _cmp(val: Optional[str], fk_col: str, texto_col: str):
            if val is None or val == "":
                filtros.append(f"pe.{fk_col} IS NULL AND (v.{texto_col} IS NULL OR v.{texto_col} = '')")
            elif val.startswith("t:"):
                params.append(val[2:])
                filtros.append(f"pe.{fk_col} IS NULL AND v.{texto_col} = ${len(params)}")
            else:
                params.append(val)
                filtros.append(f"pe.{fk_col} = ${len(params)}")

        _cmp(marca_id, 'marca_id', 'marca')
        _cmp(tipo_id, 'tipo_id', 'tipo')
        _cmp(entalle_id, 'entalle_id', 'entalle')
        _cmp(tela_id, 'tela_id', 'tela')

        sql = f"""
        SELECT
            v.product_tmpl_id,
            pt.name AS nombre,
            pe.id AS enriq_id,
            pe.estado,
            pe.odoo_stock_actual,
            pe.campos_pendientes,
            pe.marca_id, pe.tipo_id, pe.entalle_id, pe.tela_id,
            pe.tela_general_id, pe.genero_id, pe.cuello_id,
            pe.detalle_id, pe.lavado_id, pe.notas,
            pe.odoo_marca_texto, pe.odoo_tipo_texto,
            pe.odoo_entalle_texto, pe.odoo_tela_texto,
            COALESCE(SUM(v.price_subtotal * 1.18), 0)::numeric(14,2) AS ventas,
            COALESCE(SUM(v.qty), 0)::numeric(14,2) AS unidades,
            COUNT(DISTINCT v.order_id) AS tickets
        {VENTA_REAL_FROM}
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id
        LEFT JOIN odoo.product_template pt ON pt.odoo_id = v.product_tmpl_id
        WHERE v.date_order >= $1 AND v.date_order <= $2
          AND {' AND '.join(filtros)}
        GROUP BY v.product_tmpl_id, pt.name, pe.id, pe.estado, pe.odoo_stock_actual,
                 pe.campos_pendientes, pe.marca_id, pe.tipo_id, pe.entalle_id, pe.tela_id,
                 pe.tela_general_id, pe.genero_id, pe.cuello_id, pe.detalle_id, pe.lavado_id,
                 pe.notas, pe.odoo_marca_texto, pe.odoo_tipo_texto,
                 pe.odoo_entalle_texto, pe.odoo_tela_texto
        ORDER BY ventas DESC
        LIMIT 200;
        """
        rows = await conn.fetch(sql, *params)
        return {
            "items": [row_to_dict(r) for r in rows],
            "total": len(rows),
        }


@router.patch("/{enriq_id}/clasificar")
async def clasificar(
    enriq_id: str,
    body: ClasificarInput,
    current_user: dict = Depends(get_current_user),
):
    pool = await get_pool()
    async with pool.acquire() as conn:
        actual = await conn.fetchrow(
            "SELECT * FROM produccion.prod_odoo_productos_enriq WHERE id = $1", enriq_id
        )
        if not actual:
            raise HTTPException(404, "Producto no encontrado")

        tipo_nombre = None
        if body.tipo_id:
            tipo_nombre = await conn.fetchval(
                "SELECT nombre FROM produccion.prod_tipos WHERE id = $1", body.tipo_id
            )

        vals = {
            'marca_id': body.marca_id,
            'tipo_id': body.tipo_id,
            'tela_general_id': body.tela_general_id,
            'tela_id': body.tela_id,
            'entalle_id': body.entalle_id,
            'genero_id': body.genero_id,
            'cuello_id': body.cuello_id,
        }
        nuevo_estado, pendientes = _recalcular_estado(vals, tipo_nombre)

        await conn.execute("""
            UPDATE produccion.prod_odoo_productos_enriq SET
                marca_id = $1,
                tipo_id = $2,
                tela_general_id = $3,
                tela_id = $4,
                entalle_id = $5,
                genero_id = $6,
                cuello_id = $7,
                detalle_id = $8,
                lavado_id = $9,
                notas = $10,
                estado = $11,
                excluido_motivo = NULL,
                campos_pendientes = $12::jsonb,
                classified_by = $13,
                classified_at = NOW(),
                updated_at = NOW()
            WHERE id = $14
        """,
            body.marca_id, body.tipo_id, body.tela_general_id, body.tela_id,
            body.entalle_id, body.genero_id, body.cuello_id, body.detalle_id,
            body.lavado_id, body.notas,
            nuevo_estado, json.dumps(pendientes),
            current_user.get('username'), enriq_id,
        )
        return {"ok": True, "estado": nuevo_estado, "campos_pendientes": pendientes}
