"""Explorador de clasificación - drill-down.

Niveles: Marca → Tipo → Entalle → Tela → Color·Talla → terminal

El path es una lista de IDs (UUIDs de los catálogos en produccion), o el sentinel
"__sin_clasificar__" para el grupo de productos sin clasificar en ese nivel.

Usa los FKs de produccion.prod_odoo_productos_enriq (clasificación manual).
Fallback al texto de la vista v_pos_line_full cuando un producto no está clasificado.
"""
import json
from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional, List

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, VENTA_REAL_WHERE,
    rango_vista, ytd_rango, row_to_dict,
)

router = APIRouter(prefix="/api")

SIN_CLAS = "__sin_clasificar__"

# Definición de niveles: (key_field_fk, key_field_texto, catalog_table, catalog_name_col, label)
NIVELES = [
    ("marca_id",   "marca",   "prod_marcas",   "nombre", "Marca"),
    ("tipo_id",    "tipo",    "prod_tipos",    "nombre", "Tipo"),
    ("entalle_id", "entalle", "prod_entalles", "nombre", "Entalle"),
    ("tela_id",    "tela",    "prod_telas",    "nombre", "Tela"),
    # Nivel 4 es especial: color+talla, sin catálogo, viene de la vista.
]

NIVEL_NOMBRES = ["Marca", "Tipo", "Entalle", "Tela", "Color · Talla", "terminal"]


def _nivel_color_talla_groupby() -> tuple[str, str]:
    """GROUP BY del nivel 4: Color · Talla."""
    # Agrupa por par (color, talla). ID sintético: color||'|'||talla.
    return (
        "COALESCE(v.color, '') || '|' || COALESCE(v.talla, '')",
        "COALESCE(NULLIF(v.color,''),'—') || ' · ' || COALESCE(NULLIF(v.talla,''),'—')"
    )


def _construir_filtro_path(path: List[str]) -> tuple[str, list]:
    """Genera WHERE adicional basado en los elementos previos del path.

    item_id en path puede ser:
    - UUID (FK): filtrar por pe.FK_id = uuid
    - "t:{valor}": filtrar por pe.FK_id IS NULL AND v.{texto} = {valor}
    - "__sin_clasificar__": pe.FK_id IS NULL AND v.{texto} IS NULL (o vacío)
    """
    parts = []
    params = []
    for i, val in enumerate(path):
        if i >= len(NIVELES):
            # Nivel 4: Color·Talla
            sep = val.split("|", 1)
            color = sep[0] if len(sep) > 0 else ""
            talla = sep[1] if len(sep) > 1 else ""
            params.append(color)
            parts.append(f"COALESCE(v.color,'') = ${{P{len(params)}}}")
            params.append(talla)
            parts.append(f"COALESCE(v.talla,'') = ${{P{len(params)}}}")
            continue

        fk, texto_col, _, _, _ = NIVELES[i]
        if val == SIN_CLAS:
            parts.append(f"pe.{fk} IS NULL AND (v.{texto_col} IS NULL OR v.{texto_col} = '')")
        elif val.startswith("t:"):
            texto_val = val[2:]
            params.append(texto_val)
            parts.append(f"pe.{fk} IS NULL AND v.{texto_col} = ${{P{len(params)}}}")
        else:
            params.append(val)
            parts.append(f"pe.{fk} = ${{P{len(params)}}}")

    return " AND ".join(parts) if parts else "TRUE", params


async def _calcular_nivel(conn, d, h, path: List[str],
                          company_key: Optional[str],
                          location_id: Optional[int]) -> list[dict]:
    """Agrega items del nivel actual (según longitud de path).

    Ventas CON IGV via price_subtotal * 1.18 (IGV uniforme 18% PE textil), consistente
    con approach del Dashboard. No uso amount_total prorrateado porque requeriría CTEs
    pesadas con subqueries correlacionadas. Precisión ~99.9% vs prorrateo exacto.
    """
    nivel_idx = len(path)

    base_filter = [
        "v.date_order >= $1",
        "v.date_order <= $2",
        VENTA_REAL_WHERE,
    ]
    params: list = [d, h]

    if company_key and company_key != "all":
        params.append(company_key)
        base_filter.append(f"v.company_key = ${len(params)}")
    if location_id:
        params.append(location_id)
        base_filter.append(f"po.location_id = ${len(params)}")

    # Path filter
    path_filter_template, path_params = _construir_filtro_path(path)
    path_filter = path_filter_template
    for i, val in enumerate(path_params, start=1):
        params.append(val)
        path_filter = path_filter.replace(f"${{P{i}}}", f"${len(params)}")

    where_sql = " AND ".join(base_filter + [path_filter])
    join_enriq = "LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id"

    # Agrupación
    if nivel_idx < 4:
        fk, texto_col, catalog, name_col, _ = NIVELES[nivel_idx]
        # item_id: UUID si hay FK, "t:TEXTO" si hay fallback de texto, __sin_clasificar__ si ninguno
        group_expr = (
            f"CASE\n"
            f"  WHEN pe.{fk} IS NOT NULL THEN pe.{fk}::text\n"
            f"  WHEN v.{texto_col} IS NOT NULL AND v.{texto_col} <> '' THEN 't:' || v.{texto_col}\n"
            f"  ELSE '{SIN_CLAS}'\n"
            f"END"
        )
        name_expr = (
            f"CASE\n"
            f"  WHEN pe.{fk} IS NOT NULL THEN COALESCE(cat.{name_col}, pe.{fk}::text)\n"
            f"  WHEN v.{texto_col} IS NOT NULL AND v.{texto_col} <> '' THEN v.{texto_col}\n"
            f"  ELSE 'Sin clasificar'\n"
            f"END"
        )
        join_cat = f"LEFT JOIN produccion.{catalog} cat ON cat.id = pe.{fk}"
        # BOOL_OR sobre las filas del grupo — consistente porque todas comparten el mismo grupo_id.
        drill_expr = f"BOOL_OR(pe.{fk} IS NOT NULL OR (v.{texto_col} IS NOT NULL AND v.{texto_col} <> ''))"
        group_by = "1, 2"
    else:  # 4: Color·Talla
        id_expr, name_e = _nivel_color_talla_groupby()
        group_expr = id_expr
        name_expr = name_e
        join_cat = ""
        drill_expr = "false"
        group_by = "v.color, v.talla"

    sql = f"""
    SELECT
        {group_expr} AS item_id,
        {name_expr} AS nombre,
        COALESCE(SUM(v.price_subtotal * 1.18), 0)::numeric(14,2) AS ventas,
        COALESCE(SUM(v.qty), 0)::numeric(14,2) AS unidades,
        COUNT(DISTINCT v.order_id) AS tickets,
        {drill_expr} AS puede_drill
    {VENTA_REAL_FROM}
    {join_enriq}
    {join_cat}
    WHERE {where_sql}
    GROUP BY {group_by}
    ORDER BY ventas DESC NULLS LAST;
    """
    rows = await conn.fetch(sql, *params)
    return [row_to_dict(r) for r in rows]


async def _resolver_path_info(conn, path: List[str]) -> list[dict]:
    """Devuelve [{nivel, id, nombre}] para cada segmento del path (breadcrumbs)."""
    info = []
    for i, val in enumerate(path):
        nivel_label = NIVEL_NOMBRES[i] if i < len(NIVEL_NOMBRES) else str(i)
        if i >= len(NIVELES):
            # Color·Talla: no hay catálogo, reconstruir del id sintético
            sep = val.split("|", 1)
            color = sep[0] or "—"
            talla = sep[1] if len(sep) > 1 else "—"
            info.append({"nivel": nivel_label, "id": val, "nombre": f"{color or '—'} · {talla or '—'}"})
            continue
        if val == SIN_CLAS:
            info.append({"nivel": nivel_label, "id": val, "nombre": "Sin clasificar"})
            continue
        if val.startswith("t:"):
            info.append({"nivel": nivel_label, "id": val, "nombre": val[2:]})
            continue
        _, _, catalog, name_col, _ = NIVELES[i]
        row = await conn.fetchrow(
            f"SELECT {name_col} AS nombre FROM produccion.{catalog} WHERE id = $1", val
        )
        info.append({"nivel": nivel_label, "id": val, "nombre": row["nombre"] if row else val})
    return info


@router.get("/clasificacion/drill")
async def drill(
    path: str = Query("[]", description='JSON array de IDs, ej: ["uuid-marca","uuid-tipo"]'),
    vista: str = Query("ytd"),
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    anios_compara: Optional[str] = Query(None, description="coma-separados, solo YTD"),
    company_key: Optional[str] = None,
    location_id: Optional[int] = None,
    _user: dict = Depends(get_current_user),
):
    try:
        path_list: List[str] = json.loads(path)
        if not isinstance(path_list, list) or not all(isinstance(x, str) for x in path_list):
            raise ValueError
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="path debe ser JSON array de strings")

    if len(path_list) > 5:
        raise HTTPException(status_code=400, detail="path máximo 5 niveles")

    d, h = rango_vista(vista, desde, hasta)

    anios_list: List[int] = []
    if vista == "ytd" and anios_compara:
        try:
            anios_list = [int(x.strip()) for x in anios_compara.split(",") if x.strip() and int(x.strip()) != h.year]
        except ValueError:
            anios_list = []

    pool = await get_pool()
    async with pool.acquire() as conn:
        # Nivel terminal: sin items que drillear
        if len(path_list) >= 5:
            path_info = await _resolver_path_info(conn, path_list)
            return {
                "nivel_actual": NIVEL_NOMBRES[5],
                "path": path_list,
                "path_info": path_info,
                "items": [],
                "total_nivel": 0,
            }

        items_actual = await _calcular_nivel(conn, d, h, path_list, company_key, location_id)
        path_info = await _resolver_path_info(conn, path_list)

        total = sum(float(it.get("ventas") or 0) for it in items_actual)

        # Share + comparativos
        comparativos: dict[str, list[dict]] = {}
        for anio in anios_list:
            d_a, h_a = ytd_rango(anio, h)
            items_a = await _calcular_nivel(conn, d_a, h_a, path_list, company_key, location_id)
            # indexar por item_id
            comparativos[str(anio)] = {it["item_id"]: it for it in items_a}

        # Enriquecer items con share, puede_drill, var_vs_anio
        items_enriched = []
        for it in items_actual:
            ventas = float(it.get("ventas") or 0)
            share = (ventas / total * 100) if total > 0 else 0.0
            it_out = {
                "id": it["item_id"],
                "nombre": it["nombre"],
                "ventas": round(ventas, 2),
                "unidades": float(it.get("unidades") or 0),
                "tickets": int(it.get("tickets") or 0),
                "share_pct": round(share, 2),
                "puede_drill": bool(it.get("puede_drill") and len(path_list) < 4),
            }
            for anio_s, idx_a in comparativos.items():
                ant = idx_a.get(it["item_id"])
                v_ant = float(ant["ventas"]) if ant else 0.0
                it_out[f"var_vs_{anio_s}_pct"] = (
                    round((ventas - v_ant) / v_ant * 100, 2) if v_ant > 0 else None
                )
            items_enriched.append(it_out)

        # Nivel actual: el que se va a mostrar (depende de path_list len)
        nivel_mostrado = NIVEL_NOMBRES[len(path_list)]

        return {
            "nivel_actual": nivel_mostrado,
            "path": path_list,
            "path_info": path_info,
            "items": items_enriched,
            "total_nivel": round(total, 2),
            "periodo_actual": {"desde": d.date().isoformat(), "hasta": h.date().isoformat()},
        }
