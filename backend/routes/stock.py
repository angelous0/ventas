"""Reporte de Stock por clasificación (marca, tipo, entalle, tela, hilo).

GET /api/stock/grupos — agrupa por las 5 dimensiones con totales de stock
GET /api/stock/grupo-detalle — desglose color × talla para un grupo específico

Aplica mismo filtro de productos prohibidos (PALABRAS_EXCLUIDAS) que el resto
de reportes de ventas.
"""
from typing import Optional, List
from fastapi import APIRouter, Depends, Query

from auth_utils import get_current_user
from db import get_pool
from helpers import row_to_dict, PALABRAS_EXCLUIDAS

router = APIRouter(prefix="/api/stock")


_patterns = ",".join(f"'%{p}%'" for p in PALABRAS_EXCLUIDAS)
# Filtro compuesto:
# 1. Nombres con palabras prohibidas (correa, saco, tallero, etc.)
# 2. Productos con purchase_ok=true AND sin marca (basura de Odoo: typos, tests)
# 3. Productos marcados como 'excluido' manualmente en Producción
EXCLUDE_WHERE = f"""
pt.odoo_id NOT IN (
    SELECT odoo_id FROM odoo.product_template
    WHERE name ILIKE ANY (ARRAY[{_patterns}])
       OR (purchase_ok = true AND (marca IS NULL OR marca = ''))
)
AND NOT EXISTS (
    SELECT 1 FROM produccion.prod_odoo_productos_enriq pe_excl
    WHERE pe_excl.odoo_template_id = pt.odoo_id
      AND pe_excl.estado = 'excluido'
)
""".strip()


@router.get("/grupos")
async def grupos(
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    entalle_id: Optional[str] = None,
    tela_id: Optional[str] = None,
    hilo_id: Optional[str] = None,
    incluir_stock_cero: bool = Query(False, description="Incluir grupos sin stock"),
    _u: dict = Depends(get_current_user),
):
    """Agrupa stock por (marca, tipo, entalle, tela, hilo).

    Prioriza FKs del catálogo, fallback a texto del template Odoo.
    El stock se suma al nivel de variante (v_stock_by_product) y se mapea
    al template/grupo via product_product.product_tmpl_id.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        where_extra = [EXCLUDE_WHERE]
        params: list = []

        def _add_filter(val: Optional[str], col: str):
            if val:
                params.append(val)
                where_extra.append(f"pe.{col} = ${len(params)}")

        _add_filter(marca_id, 'marca_id')
        _add_filter(tipo_id, 'tipo_id')
        _add_filter(entalle_id, 'entalle_id')
        _add_filter(tela_id, 'tela_id')
        _add_filter(hilo_id, 'hilo_id')

        where_sql = " AND ".join(where_extra) if where_extra else "TRUE"

        sql = f"""
        WITH stock_por_tmpl AS (
            SELECT pp.product_tmpl_id,
                   COALESCE(SUM(vs.qty), 0) AS stock_total,
                   COALESCE(SUM(vs.available_qty), 0) AS stock_disponible,
                   COALESCE(SUM(vs.reserved_qty), 0) AS stock_reservado
            FROM odoo.v_stock_by_product vs
            JOIN odoo.product_product pp ON pp.odoo_id = vs.product_id
            GROUP BY pp.product_tmpl_id
        ),
        base AS (
            SELECT
                pt.odoo_id AS tmpl_id,
                pt.name AS producto_name,
                pt.hilo AS hilo_texto,
                st.stock_total,
                st.stock_disponible,
                st.stock_reservado,
                -- Claves de grupo: FK si hay, 't:TEXTO' si hay fallback
                CASE WHEN pe.marca_id IS NOT NULL THEN pe.marca_id::text
                     WHEN pt.marca IS NOT NULL AND pt.marca <> '' THEN 't:' || pt.marca END AS grp_marca,
                CASE WHEN pe.tipo_id IS NOT NULL THEN pe.tipo_id::text
                     WHEN pt.tipo IS NOT NULL AND pt.tipo <> '' THEN 't:' || pt.tipo END AS grp_tipo,
                CASE WHEN pe.entalle_id IS NOT NULL THEN pe.entalle_id::text
                     WHEN pt.entalle IS NOT NULL AND pt.entalle <> '' THEN 't:' || pt.entalle END AS grp_entalle,
                CASE WHEN pe.tela_id IS NOT NULL THEN pe.tela_id::text
                     WHEN pt.tela IS NOT NULL AND pt.tela <> '' THEN 't:' || pt.tela END AS grp_tela,
                CASE WHEN pe.hilo_id IS NOT NULL THEN pe.hilo_id::text
                     WHEN pt.hilo IS NOT NULL AND pt.hilo <> '' THEN 't:' || pt.hilo END AS grp_hilo,
                COALESCE(ma.nombre, pt.marca) AS label_marca,
                COALESCE(ti.nombre, pt.tipo) AS label_tipo,
                COALESCE(en.nombre, pt.entalle) AS label_entalle,
                COALESCE(te.nombre, pt.tela) AS label_tela,
                COALESCE(hi.nombre, pt.hilo) AS label_hilo
            FROM odoo.product_template pt
            LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
            LEFT JOIN produccion.prod_marcas ma ON ma.id = pe.marca_id
            LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
            LEFT JOIN produccion.prod_entalles en ON en.id = pe.entalle_id
            LEFT JOIN produccion.prod_telas te ON te.id = pe.tela_id
            LEFT JOIN produccion.prod_hilos hi ON hi.id = pe.hilo_id
            LEFT JOIN stock_por_tmpl st ON st.product_tmpl_id = pt.odoo_id
            WHERE {where_sql}
        )
        SELECT
            grp_marca, grp_tipo, grp_entalle, grp_tela, grp_hilo,
            MAX(label_marca) AS marca,
            MAX(label_tipo) AS tipo,
            MAX(label_entalle) AS entalle,
            MAX(label_tela) AS tela,
            MAX(label_hilo) AS hilo,
            COUNT(DISTINCT tmpl_id) AS productos,
            COALESCE(SUM(stock_total), 0)::numeric(14,2) AS stock_total,
            COALESCE(SUM(stock_disponible), 0)::numeric(14,2) AS stock_disponible,
            COALESCE(SUM(stock_reservado), 0)::numeric(14,2) AS stock_reservado
        FROM base
        GROUP BY grp_marca, grp_tipo, grp_entalle, grp_tela, grp_hilo
        {'' if incluir_stock_cero else 'HAVING COALESCE(SUM(stock_total), 0) > 0'}
        ORDER BY stock_total DESC;
        """
        rows = await conn.fetch(sql, *params)

        items = []
        total_stock = 0
        for r in rows:
            key = "|".join([r['grp_marca'] or "", r['grp_tipo'] or "",
                            r['grp_entalle'] or "", r['grp_tela'] or "",
                            r['grp_hilo'] or ""])
            stock = float(r['stock_total'])
            total_stock += stock
            items.append({
                "key": key,
                "marca_id": r['grp_marca'],
                "tipo_id": r['grp_tipo'],
                "entalle_id": r['grp_entalle'],
                "tela_id": r['grp_tela'],
                "hilo_id": r['grp_hilo'],
                "marca": r['marca'] or "Sin clasificar",
                "tipo": r['tipo'] or "Sin clasificar",
                "entalle": r['entalle'] or "Sin clasificar",
                "tela": r['tela'] or "Sin clasificar",
                "hilo": r['hilo'] or "Sin clasificar",
                "productos": int(r['productos']),
                "stock_total": stock,
                "stock_disponible": float(r['stock_disponible']),
                "stock_reservado": float(r['stock_reservado']),
            })

        return {
            "items": items,
            "total_grupos": len(items),
            "stock_global": round(total_stock, 2),
        }


@router.get("/grupo-detalle")
async def grupo_detalle(
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    entalle_id: Optional[str] = None,
    tela_id: Optional[str] = None,
    hilo_id: Optional[str] = None,
    _u: dict = Depends(get_current_user),
):
    """Pivote color × talla para un grupo específico.

    Retorna:
      - tallas: lista ordenada de tallas presentes
      - colores: [{ color, total, tallas: {<talla>: qty, ...}, productos: [...] }]
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        where_extra = [EXCLUDE_WHERE]
        params: list = []

        def _cmp(val: Optional[str], fk_col: str, texto_col: str):
            if val is None:
                return  # no filtrar por esta dimensión
            if val == "__sin_clas__":
                where_extra.append(f"pe.{fk_col} IS NULL AND (pt.{texto_col} IS NULL OR pt.{texto_col} = '')")
            elif val.startswith("t:"):
                params.append(val[2:])
                where_extra.append(f"pe.{fk_col} IS NULL AND pt.{texto_col} = ${len(params)}")
            else:
                params.append(val)
                where_extra.append(f"pe.{fk_col} = ${len(params)}")

        _cmp(marca_id, 'marca_id', 'marca')
        _cmp(tipo_id, 'tipo_id', 'tipo')
        _cmp(entalle_id, 'entalle_id', 'entalle')
        _cmp(tela_id, 'tela_id', 'tela')
        _cmp(hilo_id, 'hilo_id', 'hilo')

        where_sql = " AND ".join(where_extra)

        sql = f"""
        SELECT
            pt.odoo_id AS tmpl_id,
            pt.name AS producto,
            vf.color,
            vf.talla,
            COALESCE(SUM(vs.qty), 0)::numeric(14,2) AS qty,
            COALESCE(SUM(vs.available_qty), 0)::numeric(14,2) AS disponible
        FROM odoo.product_template pt
        LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
        JOIN odoo.v_product_variant_flat vf ON vf.product_tmpl_id = pt.odoo_id
        LEFT JOIN odoo.v_stock_by_product vs ON vs.product_id = vf.product_product_id
        WHERE {where_sql}
          AND vf.color IS NOT NULL AND vf.color <> ''
        GROUP BY pt.odoo_id, pt.name, vf.color, vf.talla
        HAVING COALESCE(SUM(vs.qty), 0) > 0
        ORDER BY pt.name, vf.color, vf.talla;
        """
        rows = await conn.fetch(sql, *params)

        # Tallas únicas ordenadas (mezcla num y alfa → separar)
        tallas_raw = sorted(set((r['talla'] or '—') for r in rows))
        numericas = sorted([t for t in tallas_raw if t.isdigit()], key=lambda x: int(x))
        alfa = [t for t in tallas_raw if not t.isdigit()]
        orden_alfa = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'U', 'STD', '—']
        alfa_sorted = sorted(alfa, key=lambda x: (orden_alfa.index(x) if x in orden_alfa else 99, x))
        tallas = numericas + alfa_sorted

        # Pivote: color → (talla → qty), + productos
        colores_map = {}
        for r in rows:
            color = r['color'] or '— sin color —'
            talla = r['talla'] or '—'
            qty = float(r['qty'])
            if color not in colores_map:
                colores_map[color] = {
                    "color": color,
                    "total": 0,
                    "tallas": {},
                    "productos": set(),
                }
            colores_map[color]["tallas"][talla] = colores_map[color]["tallas"].get(talla, 0) + qty
            colores_map[color]["total"] += qty
            colores_map[color]["productos"].add(r['producto'])

        colores = [
            {
                "color": c["color"],
                "total": round(c["total"], 2),
                "tallas": {t: round(q, 2) for t, q in c["tallas"].items()},
                "productos": sorted(c["productos"]),
            }
            for c in colores_map.values()
        ]
        colores.sort(key=lambda x: -x["total"])

        return {
            "tallas": tallas,
            "colores": colores,
            "total_colores": len(colores),
        }
