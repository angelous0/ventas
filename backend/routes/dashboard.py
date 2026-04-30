"""Dashboard de Ventas - KPIs + comparativos same-day YTD multi-año.

Endpoint: GET /api/dashboard
Params:
  vista: ytd|7|30|custom
  desde, hasta: fechas YYYY-MM-DD (si custom)
  anios_compara: "2025,2024" (opcional, solo aplica si vista=ytd)
  company_key, location_id, departamento: filtros opcionales

Response:
  - periodo_actual: rango resuelto
  - filtros aplicados
  - kpis: KPIs del período actual
  - comparativos: {anio: kpis} para cada año pedido (same-day YTD)
  - variaciones: {anio: {metric: pct}} vs período actual
"""
import asyncio
from fastapi import APIRouter, Depends, Query
from typing import Optional, List
from datetime import datetime, timedelta

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, VENTA_REAL_WHERE, CLIENTE_SELECT,
    rango_vista, ytd_rango, row_to_dict,
)

router = APIRouter(prefix="/api")


def _split_csv(s: Optional[str]) -> List[str]:
    """Convierte 'a,b,c' → ['a','b','c'] descartando vacíos. None/'' → []."""
    if not s:
        return []
    return [x.strip() for x in s.split(",") if x.strip()]


def _aplicar_filtros(where_parts: list, params: list, company_key: Optional[str],
                     location_id: Optional[int], departamento: Optional[str],
                     tienda: Optional[str] = None, marca_id: Optional[str] = None,
                     tipo_id: Optional[str] = None):
    """Agrega filtros opcionales al WHERE manteniendo la numeración de params.

    tienda, marca_id, tipo_id: aceptan un valor o múltiples coma-separados.
    """
    if company_key and company_key != "all":
        params.append(company_key)
        where_parts.append(f"v.company_key = ${len(params)}")
    if location_id:
        params.append(location_id)
        where_parts.append(f"po.location_id = ${len(params)}")
    tiendas_list = _split_csv(tienda)
    if tiendas_list:
        params.append(tiendas_list)
        # Filtra por x_nombre del stock_location (consolida múltiples location_id con mismo nombre, ej. TALLER)
        where_parts.append(
            f"po.location_id IN (SELECT odoo_id FROM odoo.stock_location WHERE usage = 'internal' AND active = true AND x_nombre = ANY(${len(params)}::text[]))"
        )
    marcas_list = _split_csv(marca_id)
    if marcas_list:
        params.append(marcas_list)
        where_parts.append(f"pe.marca_id = ANY(${len(params)}::text[])")
    tipos_list = _split_csv(tipo_id)
    if tipos_list:
        params.append(tipos_list)
        where_parts.append(f"pe.tipo_id = ANY(${len(params)}::text[])")
    if departamento:
        params.append(departamento.strip().upper())
        where_parts.append(f"UPPER(rp_dep.state_name) = ${len(params)}")


async def _calcular_kpis(conn, d: datetime, h: datetime, company_key: Optional[str],
                         location_id: Optional[int], departamento: Optional[str],
                         tienda: Optional[str] = None, marca_id: Optional[str] = None,
                         tipo_id: Optional[str] = None) -> dict:
    """KPIs de un período [d, h]. Reutilizable para comparativos YTD multi-año.

    Ventas NETAS: amount_total por orden (exacto, con IGV).
    Devoluciones: price_subtotal × 1.18 donde qty<0 (IGV 18% uniforme PE textil).
    """
    where_parts = [
        "v.date_order >= $1",
        "v.date_order <= $2",
        VENTA_REAL_WHERE,
    ]
    params = [d, h]

    join_rp = ""
    if departamento:
        join_rp = f"LEFT JOIN odoo.res_partner rp_dep ON rp_dep.odoo_id = {CLIENTE_SELECT}"
    # JOIN a prod_odoo_productos_enriq solo si filtramos por marca/tipo
    join_pe = ""
    if marca_id or tipo_id:
        join_pe = "LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id"
    _aplicar_filtros(where_parts, params, company_key, location_id, departamento,
                     tienda=tienda, marca_id=marca_id, tipo_id=tipo_id)

    where_sql = " AND ".join(where_parts)

    sql = f"""
    WITH lineas_filtradas AS (
        SELECT
            v.order_id,
            v.qty,
            v.price_subtotal,
            po.amount_total,
            {CLIENTE_SELECT} AS cliente_id
        {VENTA_REAL_FROM}
        {join_pe}
        {join_rp}
        WHERE {where_sql}
    ),
    totales_por_orden AS (
        SELECT DISTINCT order_id, amount_total, cliente_id
        FROM lineas_filtradas
    )
    SELECT
        (SELECT COALESCE(SUM(amount_total), 0)::numeric(14,2)
         FROM totales_por_orden) AS ventas_netas,
        (SELECT COALESCE(SUM(qty), 0)::numeric(14,2)
         FROM lineas_filtradas) AS unidades,
        (SELECT COUNT(*) FROM totales_por_orden) AS tickets,
        (SELECT COUNT(DISTINCT cliente_id) FROM totales_por_orden) AS clientes_unicos,
        (SELECT COALESCE(SUM(-price_subtotal * 1.18), 0)::numeric(14,2)
         FROM lineas_filtradas WHERE qty < 0) AS devoluciones_incl,
        (SELECT COALESCE(SUM(price_subtotal * 1.18), 0)::numeric(14,2)
         FROM lineas_filtradas WHERE qty > 0) AS ventas_brutas_incl;
    """
    row = await conn.fetchrow(sql, *params)
    d_ = row_to_dict(row) if row else {}

    ventas_netas = float(d_.get("ventas_netas") or 0)
    unidades = float(d_.get("unidades") or 0)
    tickets = int(d_.get("tickets") or 0)
    ticket_prom = (ventas_netas / tickets) if tickets > 0 else 0.0
    devol = float(d_.get("devoluciones_incl") or 0)
    devol_pct = (devol / ventas_netas * 100) if ventas_netas > 0 else 0.0

    return {
        "ventas": round(ventas_netas, 2),
        "ventas_brutas": round(float(d_.get("ventas_brutas_incl") or 0), 2),
        "unidades": round(unidades, 2),
        "tickets": tickets,
        "ticket_promedio": round(ticket_prom, 2),
        "clientes_unicos": int(d_.get("clientes_unicos") or 0),
        "devoluciones_netas": round(devol, 2),
        "devoluciones_pct": round(devol_pct, 2),
    }


async def _clientes_nuevos(conn, hasta: datetime, dias: int = 30) -> int:
    """Clientes cuya PRIMERA compra histórica cae en (hasta-dias, hasta].

    Optimizado: consulta pos_order directo (NO la view v_pos_line_full).
    La view tiene JOINs pesados con pos_order_line + product_template que no
    necesitamos para contar clientes. Bajamos de ~8s → ~0.9s (8x más rápido).
    """
    ventana_inicio = hasta - timedelta(days=dias)
    sql = """
    WITH compradores_ventana AS (
        SELECT DISTINCT COALESCE(po.x_cliente_principal, po.partner_id) AS cliente_id
        FROM odoo.pos_order po
        WHERE po.date_order >= $1 AND po.date_order <= $2
          AND (po.is_cancel = false OR po.is_cancel IS NULL)
          AND (po.order_cancel = false OR po.order_cancel IS NULL)
          AND COALESCE(po.x_cliente_principal, po.partner_id) IS NOT NULL
    )
    SELECT COUNT(*) AS nuevos
    FROM compradores_ventana cv
    WHERE NOT EXISTS (
        SELECT 1
        FROM odoo.pos_order po2
        WHERE COALESCE(po2.x_cliente_principal, po2.partner_id) = cv.cliente_id
          AND po2.date_order < $1
          AND (po2.is_cancel = false OR po2.is_cancel IS NULL)
          AND (po2.order_cancel = false OR po2.order_cancel IS NULL)
        LIMIT 1
    );
    """
    row = await conn.fetchrow(sql, ventana_inicio, hasta)
    return int(row["nuevos"]) if row else 0


def _variacion_pct(actual: float, anterior: float) -> Optional[float]:
    """Variación porcentual. None si base=0 (no comparable)."""
    if anterior == 0:
        return None
    return round((actual - anterior) / anterior * 100, 2)


def _calcular_variaciones(kpis_actual: dict, kpis_anterior: dict) -> dict:
    """Variación % para las métricas principales."""
    return {
        "ventas_pct": _variacion_pct(kpis_actual["ventas"], kpis_anterior["ventas"]),
        "unidades_pct": _variacion_pct(kpis_actual["unidades"], kpis_anterior["unidades"]),
        "tickets_pct": _variacion_pct(kpis_actual["tickets"], kpis_anterior["tickets"]),
        "ticket_promedio_pct": _variacion_pct(kpis_actual["ticket_promedio"], kpis_anterior["ticket_promedio"]),
        "clientes_unicos_pct": _variacion_pct(kpis_actual["clientes_unicos"], kpis_anterior["clientes_unicos"]),
    }


@router.get("/dashboard")
async def dashboard(
    vista: str = Query("ytd", description="ytd|7|30|custom"),
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
    anios_compara: Optional[str] = Query(None, description="coma-separados, ej: '2025,2024'"),
    company_key: Optional[str] = None,
    location_id: Optional[int] = None,
    tienda: Optional[str] = Query(None, description="Nombre(s) de tienda (x_nombre) coma-separados, ej: 'GR238,GM218'"),
    marca_id: Optional[str] = Query(None, description="ID(s) de marca coma-separados"),
    tipo_id: Optional[str] = Query(None, description="ID(s) de tipo coma-separados"),
    departamento: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    d, h = rango_vista(vista, desde, hasta)

    # Años para comparar: solo aplica si vista=ytd (same-day recortado)
    anios_list: List[int] = []
    if vista == "ytd" and anios_compara:
        try:
            anios_list = [int(x.strip()) for x in anios_compara.split(",") if x.strip()]
            # Excluir el año actual (evitar comparar consigo mismo)
            anios_list = [a for a in anios_list if a != h.year]
        except ValueError:
            anios_list = []

    pool = await get_pool()

    # Cada KPI usa su propia conexión del pool → corren EN PARALELO con asyncio.gather.
    # Antes (secuencial): 4 queries × ~5s = 20s. Ahora: ~5s total (la más lenta manda).
    async def _kpis_paralelo(d_: datetime, h_: datetime):
        async with pool.acquire() as conn:
            return await _calcular_kpis(conn, d_, h_, company_key, location_id, departamento,
                                        tienda=tienda, marca_id=marca_id, tipo_id=tipo_id)

    async def _nuevos_paralelo(h_: datetime):
        async with pool.acquire() as conn:
            return await _clientes_nuevos(conn, h_, 30)

    # Período actual + comparativos + clientes nuevos 30d, todo en paralelo
    rangos_compara = [(anio, *ytd_rango(anio, h)) for anio in anios_list]
    tareas = [_kpis_paralelo(d, h)]
    tareas += [_kpis_paralelo(d_a, h_a) for _, d_a, h_a in rangos_compara]
    tareas.append(_nuevos_paralelo(h))

    resultados = await asyncio.gather(*tareas)
    kpis_actual = resultados[0]
    kpis_compara = resultados[1:1 + len(rangos_compara)]
    nuevos_30d = resultados[-1]
    kpis_actual["clientes_nuevos_30d"] = nuevos_30d

    # Armar comparativos y variaciones
    comparativos = {}
    variaciones = {}
    for (anio, d_a, h_a), kpis_a in zip(rangos_compara, kpis_compara):
        comparativos[str(anio)] = {
            "periodo": {"desde": d_a.date().isoformat(), "hasta": h_a.date().isoformat()},
            "kpis": kpis_a,
        }
        variaciones[str(anio)] = _calcular_variaciones(kpis_actual, kpis_a)

    return {
        "periodo_actual": {
            "desde": d.date().isoformat(),
            "hasta": h.date().isoformat(),
            "vista": vista,
        },
        "filtros": {
            "company_key": company_key or "all",
            "location_id": location_id,
            "tienda": tienda,
            "marca_id": marca_id,
            "tipo_id": tipo_id,
            "departamento": departamento,
        },
        "kpis": kpis_actual,
        "comparativos": comparativos,
        "variaciones": variaciones,
    }


# ============================================================
# ENDPOINT: /dashboard/evolucion-mensual
# Devuelve serie mensual de los últimos N años (Ene-Dic × año) en UNA query.
# Mucho más eficiente que N×12 calls al endpoint /dashboard.
# Usado por el componente EvolucionMensual del frontend.
# ============================================================
@router.get("/dashboard/evolucion-mensual")
async def dashboard_evolucion_mensual(
    anios: Optional[str] = Query("2024,2025,2026", description="Años a comparar coma-separados"),
    company_key: Optional[str] = None,
    tienda: Optional[str] = Query(None, description="x_nombre tiendas csv"),
    marca_id: Optional[str] = None,
    tipo_id: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    """Serie mensual de ventas/unidades/tickets por (año, mes), 1 query agregada.

    Respuesta:
      {
        "anios": [2024, 2025, 2026],
        "series": {
          "2024": [{ "mes": 1, "ventas": ..., "unidades": ..., "tickets": ... }, ...],
          "2025": [...],
          "2026": [...]
        }
      }
    """
    try:
        anios_list = [int(x.strip()) for x in (anios or "").split(",") if x.strip()]
    except ValueError:
        anios_list = []
    if not anios_list:
        anios_list = [datetime.now().year - 2, datetime.now().year - 1, datetime.now().year]

    anio_min = min(anios_list)
    anio_max = max(anios_list)

    where_parts = [
        f"v.date_order >= '{anio_min}-01-01'",
        f"v.date_order < '{anio_max + 1}-01-01'",
        VENTA_REAL_WHERE,
    ]
    params = []

    join_pe = ""
    if marca_id or tipo_id:
        join_pe = "LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = v.product_tmpl_id"
    _aplicar_filtros(where_parts, params, company_key, None, None,
                     tienda=tienda, marca_id=marca_id, tipo_id=tipo_id)

    where_sql = " AND ".join(where_parts)

    sql = f"""
    WITH lineas AS (
        SELECT
            EXTRACT(YEAR FROM (v.date_order AT TIME ZONE 'America/Lima'))::int  AS anio,
            EXTRACT(MONTH FROM (v.date_order AT TIME ZONE 'America/Lima'))::int AS mes,
            v.order_id,
            v.qty,
            v.price_subtotal,
            po.amount_total
        {VENTA_REAL_FROM}
        {join_pe}
        WHERE {where_sql}
    ),
    ordenes AS (
        SELECT DISTINCT anio, mes, order_id, amount_total FROM lineas
    )
    SELECT
        l.anio,
        l.mes,
        COALESCE((SELECT SUM(amount_total)::numeric(14,2) FROM ordenes o WHERE o.anio = l.anio AND o.mes = l.mes), 0) AS ventas,
        SUM(l.qty)::numeric(14,2) AS unidades,
        (SELECT COUNT(*) FROM ordenes o WHERE o.anio = l.anio AND o.mes = l.mes) AS tickets
    FROM lineas l
    GROUP BY l.anio, l.mes
    ORDER BY l.anio, l.mes;
    """

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    # Inicializar serie completa (12 meses por año, ceros si no hay)
    series = {str(a): [{"mes": m, "ventas": 0.0, "unidades": 0.0, "tickets": 0} for m in range(1, 13)] for a in anios_list}
    for r in rows:
        a = int(r["anio"])
        m = int(r["mes"])
        if str(a) in series:
            series[str(a)][m - 1] = {
                "mes": m,
                "ventas": float(r["ventas"] or 0),
                "unidades": float(r["unidades"] or 0),
                "tickets": int(r["tickets"] or 0),
            }

    return {
        "anios": anios_list,
        "series": series,
        "filtros": {
            "company_key": company_key, "tienda": tienda,
            "marca_id": marca_id, "tipo_id": tipo_id,
        },
    }
