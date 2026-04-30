"""Reposición de inventario por tienda.

Performance: cold start ~1.7-2s, cache caliente <1s. La query EWMA hace
seq scan parcial sobre v_pos_line_full (60 días). Para llevarlo a <0.5s
estable: materializar `mv_velocidad_ewma` actualizada cada hora — pendiente
para el siguiente sprint si la performance no es suficiente.


Tres endpoints que responden la pregunta operativa
"¿qué pido y a quién hoy?":

1. /snapshot   — KPIs de salud de la tienda (stock, críticos, sobrestock, cobertura)
2. /flujo      — Serie diaria de entradas/salidas + balance neto del período
3. /reposicion — Lista priorizada de SKUs a reponer con origen sugerido

Reglas transversales (sprint spec):
- Aplica VENTA_REAL_WHERE de helpers.py para velocidad de venta
- Aplica EXCLUDE_WHERE (palabras prohibidas + estado excluido) de stock.py
- Velocidad EWMA con decay 30d sobre ventana 90d
- Agrupación por (marca, tipo, entalle, tela) por defecto, modelo solo en drill-down
- Origen sugerido: 1) tienda con cobertura ≥ 90d del MISMO grupo, 2) ALMACEN
"""
import asyncio
import hashlib
import logging
from typing import Optional, List
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, Query, HTTPException

from auth_utils import get_current_user
from db import get_pool
from helpers import VENTA_REAL_FROM, VENTA_REAL_WHERE, PALABRAS_EXCLUIDAS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/inventario")


# Filtro de productos válidos a nivel template (mismo patrón que stock.py)
_patterns_sql = ",".join(f"'%{p}%'" for p in PALABRAS_EXCLUIDAS)
EXCLUDE_WHERE_PT = f"""
pt.odoo_id NOT IN (
    SELECT odoo_id FROM odoo.product_template
    WHERE name ILIKE ANY (ARRAY[{_patterns_sql}])
       OR (purchase_ok = true AND (marca IS NULL OR marca = ''))
)
AND NOT EXISTS (
    SELECT 1 FROM produccion.prod_odoo_productos_enriq pe_excl
    WHERE pe_excl.odoo_template_id = pt.odoo_id
      AND pe_excl.estado = 'excluido'
)
""".strip()

# Constantes de negocio (algunas configurables a futuro)
LOTE_MINIMO_DEFAULT = 12
LEAD_TIME_DEFAULT = 7  # días desde almacén/transferencia hasta tienda
COBERTURA_CRITICA = 7
COBERTURA_BAJA = 15
COBERTURA_SOBRESTOCK = 90

# Cobertura objetivo dinámica según velocidad: SKUs muy rápidos cubren
# menos días (más rotación, menos tiempo expuesto a quiebre); los lentos
# cubren más para no bombear pequeño cada poco.
def cobertura_efectiva(vel_diaria: float, default_min: int = 30) -> int:
    """Devuelve los días objetivo de cobertura para esta velocidad.

    >50 und/d → 14d (rápido, repongo seguido)
    >5  und/d → 30d (medio)
    ≤5  und/d → 60d (lento, evita pedidos chicos frecuentes)
    """
    if vel_diaria > 50:
        return 14
    if vel_diaria > 5:
        return 30
    return 60

# Tope físico por SKU si no hay config (registra warning).
TOPE_DEFAULT_POR_SKU = 50

# ─────────────────────────────────────────────────────────────────
# Constantes del estimador EWMA de velocidad de venta
# ─────────────────────────────────────────────────────────────────
# La velocidad diaria con decay exponencial τ días sobre una ventana W:
#     λ̂ = SUM(qty_i * exp(-edad_i / τ)) / (τ * (1 - exp(-W / τ)))
#
# El divisor NO debe ser SUM(exp(...)) — eso da el promedio ponderado del
# tamaño de línea (qty por venta), no la velocidad por día. Bug histórico
# corregido el 2026-04-30: la fórmula vieja inflaba ~27× la velocidad real
# después del GROUP BY pp_id porque cada SKU devolvía ~1.1 (qty media por
# línea) y al sumar entre SKUs del grupo daba N_SKUs × 1.1.
EWMA_DECAY_DAYS = 30.0   # τ
EWMA_WINDOW_DAYS = 60    # W (días que la query mira hacia atrás)
# Constante de normalización pre-calculada para SQL: τ × (1 − e^(−W/τ))
# Para τ=30, W=60: 30 × (1 − e^(−2)) ≈ 25.945
EWMA_NORMALIZER_SQL = f"({EWMA_DECAY_DAYS} * (1.0 - EXP(-{EWMA_WINDOW_DAYS}.0 / {EWMA_DECAY_DAYS})))"

# Override de lote por tipo (ejemplo, se puede mover a tabla de configuración)
LOTE_POR_TIPO = {
    'pantalon': 12,
    'short': 12,
    'polo': 24,
    'camiseta': 24,
    'casaca': 6,
}

ESTADOS_TRANSITO = ('waiting', 'confirmed', 'partially_available', 'assigned')


def lote_para(tipo_nombre: Optional[str]) -> int:
    if not tipo_nombre:
        return LOTE_MINIMO_DEFAULT
    return LOTE_POR_TIPO.get(tipo_nombre.strip().lower(), LOTE_MINIMO_DEFAULT)


def estado_por_cobertura(cob_dias: Optional[float], stock: int, vel: float) -> str:
    """Clasifica un SKU según su cobertura."""
    if stock <= 0:
        # Si no hay stock pero sí hay velocidad → quiebre crítico
        return 'crit' if vel > 0 else 'dead'
    if vel <= 0:
        # Stock pero sin venta → muerto
        return 'dead'
    if cob_dias is None:
        return 'ok'
    if cob_dias <= COBERTURA_CRITICA:
        return 'crit'
    if cob_dias <= COBERTURA_BAJA:
        return 'warn'
    if cob_dias >= COBERTURA_SOBRESTOCK:
        return 'over'
    return 'ok'


def confianza_por_historia(dias_historia: int) -> str:
    if dias_historia >= 60:
        return 'alta'
    if dias_historia >= 14:
        return 'media'
    return 'baja'


def grupo_id(marca: str, tipo: str, entalle: str, tela: str) -> str:
    """Hash estable para identificar el grupo (marca,tipo,entalle,tela)."""
    raw = f"{marca or ''}|{tipo or ''}|{entalle or ''}|{tela or ''}".lower()
    return hashlib.md5(raw.encode()).hexdigest()[:12]


# ============================================================
# 1. /snapshot
# ============================================================
@router.get("/snapshot")
async def snapshot(
    tienda: str = Query(..., description="x_nombre de la tienda"),
    _u: dict = Depends(get_current_user),
):
    """KPIs de salud de la tienda."""
    pool = await get_pool()
    # NOTA: cada query del gather usa SU PROPIA conexión. Una asyncpg.Connection
    # solo permite UNA operación a la vez; compartirla en gather() lanza
    # InterfaceError("cannot perform operation: another operation is in progress").
    # 1. Stock actual + velocidad EWMA por SKU (variante product_product)
    # 2. Agregamos a nivel tienda
    sql_skus = f"""
    WITH stock_actual AS (
        SELECT pp.odoo_id AS pp_id, pt.odoo_id AS tmpl_id,
               pt.list_price,
               COALESCE(SUM(q.qty), 0)::numeric AS stock
        FROM odoo.stock_quant q
        JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
        JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
        JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
        WHERE q.qty > 0
          AND sl.x_nombre = $1
          AND sl.usage = 'internal' AND sl.active = true
          AND {EXCLUDE_WHERE_PT}
        GROUP BY 1, 2, 3
    ),
    ventas_90d AS (
        SELECT
            v.product_id AS pp_id,
            -- EWMA velocidad diaria. Divisor = τ × (1 − e^(−W/τ)), NO SUM(decay):
            -- ese error anterior daba el promedio de qty por línea, no u/día.
            COALESCE(SUM(v.qty * EXP(-EXTRACT(EPOCH FROM (NOW() - v.date_order)) / 86400.0 / {EWMA_DECAY_DAYS})), 0)
              / {EWMA_NORMALIZER_SQL} AS vel_diaria_ewma
        {VENTA_REAL_FROM}
        JOIN odoo.stock_location sl ON sl.odoo_id = po.location_id
        WHERE v.date_order >= NOW() - INTERVAL '{EWMA_WINDOW_DAYS} days'
          AND sl.x_nombre = $1
          AND sl.usage = 'internal' AND sl.active = true
          AND v.qty > 0
          AND {VENTA_REAL_WHERE}
        GROUP BY 1
    )
    SELECT s.tmpl_id, s.stock, s.list_price,
           COALESCE(v.vel_diaria_ewma, 0) AS vel
    FROM stock_actual s
    LEFT JOIN ventas_90d v ON v.pp_id = s.pp_id;
    """

    sql_transito = """
    SELECT COALESCE(SUM(sm.product_qty), 0)::int AS unidades
    FROM odoo.stock_move sm
    JOIN odoo.stock_location sl_dest ON sl_dest.odoo_id = sm.location_dest_id
    WHERE sm.state = ANY($2::text[])
      AND sl_dest.x_nombre = $1;
    """

    # Desglose por tipo (auto-match por texto si no hay FK en pe.tipo_id).
    # Sirve para mostrar la composición del inventario en el panel §01.
    sql_por_tipo = f"""
    SELECT
        COALESCE(ti.nombre, ti_auto.nombre, NULLIF(pt.tipo, ''), '— sin tipo —') AS tipo,
        COUNT(DISTINCT pt.odoo_id) AS modelos,
        SUM(q.qty)::int AS stock
    FROM odoo.stock_quant q
    JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
    JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
    JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
    LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
    LEFT JOIN produccion.prod_tipos ti ON ti.id = pe.tipo_id
    LEFT JOIN produccion.prod_tipos ti_auto
        ON pe.tipo_id IS NULL AND pt.tipo <> ''
        AND LOWER(TRIM(ti_auto.nombre)) = LOWER(TRIM(SPLIT_PART(pt.tipo, ' ', 1)))
    WHERE q.qty > 0
      AND sl.x_nombre = $1
      AND sl.usage = 'internal' AND sl.active = true
      AND {EXCLUDE_WHERE_PT}
    GROUP BY 1
    HAVING SUM(q.qty) > 0
    ORDER BY stock DESC;
    """

    async def _q_skus():
        async with pool.acquire() as conn:
            return await conn.fetch(sql_skus, tienda)

    async def _q_transito():
        async with pool.acquire() as conn:
            return await conn.fetchrow(sql_transito, tienda, list(ESTADOS_TRANSITO))

    async def _q_por_tipo():
        async with pool.acquire() as conn:
            return await conn.fetch(sql_por_tipo, tienda)

    rows, transito, por_tipo_rows = await asyncio.gather(
        _q_skus(), _q_transito(), _q_por_tipo()
    )

    # Agregar KPIs
    stock_total = 0
    valor_inventario = 0.0
    items_criticos = 0
    items_bajos = 0
    items_sobrestock = 0
    items_muertos = 0
    cobertura_ponderada = 0.0
    stock_ponderado = 0  # para promedio ponderado por stock

    for r in rows:
        stock = float(r["stock"]) or 0
        vel = float(r["vel"]) or 0
        precio = float(r["list_price"] or 0)
        cob = (stock / vel) if vel > 0 else None

        stock_total += stock
        valor_inventario += stock * precio

        estado = estado_por_cobertura(cob, int(stock), vel)
        if estado == 'crit':
            items_criticos += 1
        elif estado == 'warn':
            items_bajos += 1
        elif estado == 'over':
            items_sobrestock += 1
        elif estado == 'dead':
            items_muertos += 1

        if cob is not None and stock > 0:
            cobertura_ponderada += cob * stock
            stock_ponderado += stock

    cobertura_promedio = (cobertura_ponderada / stock_ponderado) if stock_ponderado > 0 else None

    # Desglose por tipo con %
    total_por_tipo = sum(int(r["stock"]) for r in por_tipo_rows)
    por_tipo = [
        {
            "tipo": r["tipo"],
            "modelos": int(r["modelos"]),
            "stock": int(r["stock"]),
            "pct": round((int(r["stock"]) / total_por_tipo * 100), 1) if total_por_tipo > 0 else 0,
        }
        for r in por_tipo_rows
    ]

    return {
        "tienda": tienda,
        "stock_total": int(stock_total),
        "valor_inventario": round(valor_inventario, 2),
        "items_criticos": items_criticos,
        "items_bajos": items_bajos,
        "items_sobrestock": items_sobrestock,
        "items_muertos": items_muertos,
        "en_transito_unidades": int(transito["unidades"]) if transito else 0,
        "cobertura_promedio_dias": round(cobertura_promedio, 1) if cobertura_promedio is not None else None,
        "por_tipo": por_tipo,
    }


# ============================================================
# 2. /flujo
# ============================================================
@router.get("/flujo")
async def flujo(
    tienda: str = Query(..., description="x_nombre de la tienda"),
    dias: int = Query(30, ge=1, le=365),
    _u: dict = Depends(get_current_user),
):
    """Serie diaria de entradas/salidas + stock al cierre.

    IMPORTANTE: el balance_neto que se reporta es solo (ventas + devoluciones),
    NO incluye trans_out porque las transferencias entre tiendas propias no
    son pérdida real de stock — se conservan en otra ubicación.
    """
    pool = await get_pool()
    desde_dt = datetime.now() - timedelta(days=dias)

    # NOTA: cada query del gather usa SU PROPIA conexión (ver /snapshot).
    # Filtro sl.usage='internal' AND sl.active=true es defensivo: evita que
    # un x_nombre duplicado (ej. otra location con el mismo nombre y otro usage)
    # multiplique las filas. Sin él, dos locations homónimas duplicarían los datos.
    # Ventas diarias en la tienda (solo qty > 0 = ventas reales)
    sql_ventas = f"""
    SELECT
        (v.date_order AT TIME ZONE 'America/Lima')::date AS fecha,
        COALESCE(SUM(v.qty), 0)::int AS unidades
    {VENTA_REAL_FROM}
    JOIN odoo.stock_location sl ON sl.odoo_id = po.location_id
    WHERE v.date_order >= $2
      AND sl.x_nombre = $1
      AND sl.usage = 'internal' AND sl.active = true
      AND v.qty > 0
      AND {VENTA_REAL_WHERE}
    GROUP BY 1
    ORDER BY 1;
    """

    # Devoluciones (qty < 0 → suman al stock)
    sql_devol = f"""
    SELECT
        (v.date_order AT TIME ZONE 'America/Lima')::date AS fecha,
        COALESCE(SUM(-v.qty), 0)::int AS unidades
    {VENTA_REAL_FROM}
    JOIN odoo.stock_location sl ON sl.odoo_id = po.location_id
    WHERE v.date_order >= $2
      AND sl.x_nombre = $1
      AND sl.usage = 'internal' AND sl.active = true
      AND v.qty < 0
      AND {VENTA_REAL_WHERE}
    GROUP BY 1
    ORDER BY 1;
    """

    # Movimientos done a/desde la tienda (transferencias completadas)
    sql_moves = """
    SELECT
        (sm.date AT TIME ZONE 'America/Lima')::date AS fecha,
        CASE
            WHEN sl_dest.x_nombre = $1 THEN 'in'
            WHEN sl_orig.x_nombre = $1 THEN 'out'
            ELSE 'other'
        END AS direccion,
        COALESCE(SUM(sm.product_qty), 0)::int AS unidades
    FROM odoo.stock_move sm
    JOIN odoo.stock_location sl_orig ON sl_orig.odoo_id = sm.location_id
    JOIN odoo.stock_location sl_dest ON sl_dest.odoo_id = sm.location_dest_id
    WHERE sm.state = 'done'
      AND sm.date >= $2
      AND (sl_orig.x_nombre = $1 OR sl_dest.x_nombre = $1)
      AND sl_orig.x_nombre <> sl_dest.x_nombre
    GROUP BY 1, 2
    ORDER BY 1;
    """

    # Stock actual de la tienda para reconstruir cierre por día (hacia atrás)
    sql_stock_actual = """
    SELECT COALESCE(SUM(q.qty), 0)::int AS stock
    FROM odoo.stock_quant q
    JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
    WHERE sl.x_nombre = $1 AND q.qty > 0
      AND sl.usage = 'internal' AND sl.active = true;
    """

    async def _fetch(sql, *args):
        async with pool.acquire() as conn:
            return await conn.fetch(sql, *args)

    async def _fetchrow(sql, *args):
        async with pool.acquire() as conn:
            return await conn.fetchrow(sql, *args)

    ventas_rows, devol_rows, moves_rows, stock_actual_row = await asyncio.gather(
        _fetch(sql_ventas, tienda, desde_dt),
        _fetch(sql_devol, tienda, desde_dt),
        _fetch(sql_moves, tienda, desde_dt),
        _fetchrow(sql_stock_actual, tienda),
    )
    stock_actual = int(stock_actual_row["stock"]) if stock_actual_row else 0

    # Construir serie por día
    by_fecha = {}
    for r in ventas_rows:
        f = r["fecha"].isoformat()
        by_fecha.setdefault(f, {"fecha": f, "ventas": 0, "devoluciones": 0, "trans_in": 0, "trans_out": 0})
        by_fecha[f]["ventas"] = int(r["unidades"])
    for r in devol_rows:
        f = r["fecha"].isoformat()
        by_fecha.setdefault(f, {"fecha": f, "ventas": 0, "devoluciones": 0, "trans_in": 0, "trans_out": 0})
        by_fecha[f]["devoluciones"] = int(r["unidades"])
    for r in moves_rows:
        f = r["fecha"].isoformat()
        by_fecha.setdefault(f, {"fecha": f, "ventas": 0, "devoluciones": 0, "trans_in": 0, "trans_out": 0})
        if r["direccion"] == 'in':
            by_fecha[f]["trans_in"] = int(r["unidades"])
        elif r["direccion"] == 'out':
            by_fecha[f]["trans_out"] = int(r["unidades"])

    items = sorted(by_fecha.values(), key=lambda x: x["fecha"])

    # Reconstruir stock_cierre yendo HACIA ATRÁS desde stock actual
    # cierre[t] = cierre[t+1] + ventas[t+1] - devoluciones[t+1] - trans_in[t+1] + trans_out[t+1]
    # Más simple: stock_cierre[hoy] = stock_actual; cierre[t-1] = cierre[t] + ventas[t] - dev[t] - in[t] + out[t]
    # Procesamos al revés.
    if items:
        items_rev = list(reversed(items))
        prev_close = stock_actual
        for it in items_rev:
            it["stock_cierre"] = prev_close
            prev_close = prev_close + it["ventas"] - it["devoluciones"] - it["trans_in"] + it["trans_out"]
        items = list(reversed(items_rev))

    # Totales
    tot_ventas = sum(it["ventas"] for it in items)
    tot_devol = sum(it["devoluciones"] for it in items)
    tot_in = sum(it["trans_in"] for it in items)
    tot_out = sum(it["trans_out"] for it in items)

    return {
        "tienda": tienda,
        "dias": dias,
        "items": items,
        "totales": {
            "ventas": tot_ventas,
            "devoluciones": tot_devol,
            "trans_in": tot_in,
            "trans_out": tot_out,
            # balance_neto = solo "pérdida real" para la cadena (lo que sale a clientes - devoluciones)
            "balance_neto": tot_ventas - tot_devol,
        },
        "stock_actual": stock_actual,
    }


# ============================================================
# 3. /reposicion
# ============================================================
@router.get("/reposicion")
async def reposicion(
    tienda: str = Query(..., description="x_nombre de la tienda destino"),
    cobertura_objetivo: int = Query(30, ge=7, le=120),
    nivel: str = Query("grupo", regex="^(grupo|modelo)$"),
    incluir: str = Query("crit,warn,dead", description="csv: crit,warn,ok,over,dead"),
    _u: dict = Depends(get_current_user),
):
    """Lista priorizada de SKUs a reponer en la tienda destino.

    Lógica:
      1. Stock actual + en tránsito por SKU/grupo en la tienda destino
      2. Velocidad EWMA 30d/90d (misma fórmula que /snapshot)
      3. Stock proyectado = actual + en_transito - vel*lead_time
      4. Sugerido teórico = max(0, vel*cobertura_objetivo - stock_proyectado)
      5. Sugerido pedido = ceil(sug_teorico / lote) * lote
      6. Origen: tienda con cobertura ≥ 90d del mismo grupo, sino ALMACEN
      7. Ordenar por margen_perdido_dia DESC
    """
    pool = await get_pool()
    incluir_set = {x.strip() for x in (incluir or "").split(",") if x.strip()}

    # NOTA: cada query del gather usa SU PROPIA conexión (ver /snapshot).
    # Query base: stock por tmpl_id (o pp_id si nivel=modelo) en TODAS las tiendas.
    # Esto sirve para 1) calcular el destino 2) buscar origen interno
    sql_stock = f"""
    SELECT
        sl.x_nombre AS tienda,
        pp.odoo_id AS pp_id,
        pt.odoo_id AS tmpl_id,
        pt.name AS modelo,
        pt.list_price,
        COALESCE(ma.nombre, ma_auto.nombre, pt.marca, '— sin marca —') AS marca,
        COALESCE(ti.nombre, ti_auto.nombre, pt.tipo, '— sin tipo —') AS tipo,
        COALESCE(en.nombre, en_auto.nombre, pt.entalle, '— sin entalle —') AS entalle,
        COALESCE(te.nombre, te_auto.nombre, pt.tela, '— sin tela —') AS tela,
        SUM(q.qty)::numeric AS stock
    FROM odoo.stock_quant q
    JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
    JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
    JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
    LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
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
    WHERE q.qty > 0
      AND sl.usage = 'internal' AND sl.active = true
      AND sl.x_nombre IS NOT NULL AND sl.x_nombre <> ''
      AND {EXCLUDE_WHERE_PT}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
    HAVING SUM(q.qty) > 0;
    """

    # Velocidad EWMA por (tienda, pp_id). Misma fórmula corregida que /snapshot:
    #   λ̂ = SUM(qty × e^(−edad/τ)) / (τ × (1 − e^(−W/τ)))
    # Nota: aquí NO filtramos por tienda destino sino que devolvemos todas
    # las (tienda, pp_id) — el agrupamiento posterior decide a quién aplica.
    # Filtro sl.usage='internal' AND sl.active=true para prevenir duplicación
    # por x_nombre repetido en stock_location.
    sql_vel = f"""
    SELECT
        sl.x_nombre AS tienda,
        v.product_id AS pp_id,
        COUNT(DISTINCT (v.date_order AT TIME ZONE 'America/Lima')::date) AS dias_con_venta,
        COALESCE(SUM(v.qty * EXP(-EXTRACT(EPOCH FROM (NOW() - v.date_order)) / 86400.0 / {EWMA_DECAY_DAYS})), 0)
          / {EWMA_NORMALIZER_SQL} AS vel_ewma
    {VENTA_REAL_FROM}
    JOIN odoo.stock_location sl ON sl.odoo_id = po.location_id
    WHERE v.date_order >= NOW() - INTERVAL '{EWMA_WINDOW_DAYS} days'
      AND v.qty > 0
      AND sl.usage = 'internal' AND sl.active = true
      AND {VENTA_REAL_WHERE}
    GROUP BY 1, 2;
    """

    # En tránsito hacia la tienda destino, por pp_id
    sql_transito = """
    SELECT sm.product_id AS pp_id,
           COALESCE(SUM(sm.product_qty), 0)::numeric AS unidades
    FROM odoo.stock_move sm
    JOIN odoo.stock_location sl ON sl.odoo_id = sm.location_dest_id
    WHERE sm.state = ANY($2::text[])
      AND sl.x_nombre = $1
    GROUP BY 1;
    """

    # Topes físicos por (tienda × tipo) — sólo los activos.
    sql_topes = """
    SELECT tipo_nombre, stock_max_por_sku
    FROM produccion.config_stock_max
    WHERE tienda_codigo = $1 AND activo = TRUE;
    """

    async def _q_stock():
        async with pool.acquire() as conn:
            return await conn.fetch(sql_stock)

    async def _q_vel():
        async with pool.acquire() as conn:
            return await conn.fetch(sql_vel)

    async def _q_trans():
        async with pool.acquire() as conn:
            return await conn.fetch(sql_transito, tienda, list(ESTADOS_TRANSITO))

    async def _q_topes():
        async with pool.acquire() as conn:
            return await conn.fetch(sql_topes, tienda)

    stock_rows, vel_rows, trans_rows, topes_rows = await asyncio.gather(
        _q_stock(), _q_vel(), _q_trans(), _q_topes()
    )

    # Mapa {tipo: tope_por_sku}. Si falta un tipo, usamos default y avisamos.
    topes_por_tipo = {r["tipo_nombre"]: int(r["stock_max_por_sku"]) for r in topes_rows}
    _tipos_sin_tope_warn = set()  # para no spamear el log con el mismo tipo

    # Indexar
    # vel_idx[(tienda, pp_id)] = (vel, dias_con_venta)
    vel_idx = {(r["tienda"], r["pp_id"]): (float(r["vel_ewma"] or 0), int(r["dias_con_venta"])) for r in vel_rows}
    trans_idx = {r["pp_id"]: float(r["unidades"] or 0) for r in trans_rows}

    # Reorganizar stock por (tienda, pp_id, tmpl_id, ...)
    # Y armar el "universo" de items en la tienda destino
    items_destino = []  # cada uno con su pp_id, tmpl_id, datos, stock destino
    stock_por_tienda_pp = {}  # {(tienda, pp_id): stock}
    stock_por_tienda_grupo = {}  # {(tienda, grupo_id): stock} para lookup rápido del origen
    grupo_meta = {}  # {grupo_id: {marca, tipo, entalle, tela}}

    for r in stock_rows:
        gid = grupo_id(r["marca"], r["tipo"], r["entalle"], r["tela"])
        grupo_meta[gid] = {
            "marca": r["marca"], "tipo": r["tipo"],
            "entalle": r["entalle"], "tela": r["tela"],
        }
        stock_v = float(r["stock"] or 0)
        stock_por_tienda_pp[(r["tienda"], r["pp_id"])] = stock_v
        stock_por_tienda_grupo[(r["tienda"], gid)] = stock_por_tienda_grupo.get((r["tienda"], gid), 0) + stock_v

        if r["tienda"] == tienda:
            items_destino.append({
                "pp_id": r["pp_id"],
                "tmpl_id": r["tmpl_id"],
                "modelo": r["modelo"],
                "list_price": float(r["list_price"] or 0),
                "marca": r["marca"], "tipo": r["tipo"],
                "entalle": r["entalle"], "tela": r["tela"],
                "grupo_id": gid,
                "stock": stock_v,
            })

    # Agregar SKUs que tienen ventas en tienda pero stock = 0 (quiebres críticos)
    for (t, pp_id), (vel, _dias) in vel_idx.items():
        if t != tienda:
            continue
        if (t, pp_id) in stock_por_tienda_pp:
            continue
        # Stock 0 pero con velocidad — necesitamos su metadata
        # Buscamos en stock_rows por pp_id (cualquier tienda)
        meta = next((r for r in stock_rows if r["pp_id"] == pp_id), None)
        if not meta:
            continue
        gid = grupo_id(meta["marca"], meta["tipo"], meta["entalle"], meta["tela"])
        grupo_meta.setdefault(gid, {
            "marca": meta["marca"], "tipo": meta["tipo"],
            "entalle": meta["entalle"], "tela": meta["tela"],
        })
        items_destino.append({
            "pp_id": pp_id,
            "tmpl_id": meta["tmpl_id"],
            "modelo": meta["modelo"],
            "list_price": float(meta["list_price"] or 0),
            "marca": meta["marca"], "tipo": meta["tipo"],
            "entalle": meta["entalle"], "tela": meta["tela"],
            "grupo_id": gid,
            "stock": 0.0,
        })

    # ============================================================
    # ETAPA 1 — Sugerencia por SKU sin tope físico
    #
    # Cap aplicado en esta etapa:
    #   • Cobertura objetivo dinámica según velocidad (cap suave).
    # El tope físico (tienda × tipo) se aplica DESPUÉS, a nivel grupo
    # (ETAPA 2), porque el usuario lo entiende como "cuántas unidades
    # de Pantalon Semipitillo Comfort caben en la tienda" — no por
    # variante color×talla.
    # ============================================================
    sugerencias = []
    for it in items_destino:
        vel, dias_hist = vel_idx.get((tienda, it["pp_id"]), (0.0, 0))
        en_transito = trans_idx.get(it["pp_id"], 0.0)
        stock = it["stock"]
        # Stock proyectado al cabo del lead-time
        stock_proy = stock + en_transito - vel * LEAD_TIME_DEFAULT
        cob = (stock / vel) if vel > 0 else None

        estado = estado_por_cobertura(cob, int(stock), vel)

        # Cobertura objetivo dinámica (cap suave por velocidad).
        # El parámetro `cobertura_objetivo` recibido del cliente actúa como
        # techo: nunca cubrimos más días que los pedidos.
        cob_dinamica = cobertura_efectiva(vel)
        cob_efectiva = min(cob_dinamica, cobertura_objetivo)

        sug_teorico = max(0.0, vel * cob_efectiva - stock_proy)

        # Resolver tope aplicable a este tipo (config_stock_max). Default 50
        # con warning si la combinación (tienda, tipo) no está configurada.
        tipo_nombre = it["tipo"]
        tope_tipo = topes_por_tipo.get(tipo_nombre)
        if tope_tipo is None:
            if tipo_nombre not in _tipos_sin_tope_warn:
                logger.warning(
                    "config_stock_max sin entrada para (tienda=%s, tipo=%s); "
                    "usando default %d",
                    tienda, tipo_nombre, TOPE_DEFAULT_POR_SKU,
                )
                _tipos_sin_tope_warn.add(tipo_nombre)
            tope_tipo = TOPE_DEFAULT_POR_SKU

        # ETAPA 1: sugerido_pedido sin cap físico (solo cap suave de cobertura).
        lote = lote_para(tipo_nombre)
        if sug_teorico > 0:
            sug_pedido_pre = int((-(-sug_teorico // lote)) * lote)  # ceil al lote
        else:
            sug_pedido_pre = 0

        # Origen sugerido: tienda con cobertura ≥ 90d del MISMO grupo, sino ALMACEN
        origen = "ALMACEN"
        for (t, gid), stock_t in stock_por_tienda_grupo.items():
            if t == tienda:
                continue
            if gid != it["grupo_id"]:
                continue
            if vel > 0:
                cob_origen = stock_t / vel
            else:
                cob_origen = float('inf') if stock_t > 0 else 0
            if cob_origen >= COBERTURA_SOBRESTOCK and stock_t >= sug_pedido_pre:
                origen = t
                break

        confianza = confianza_por_historia(dias_hist)
        margen_perdido_dia = vel * it["list_price"] if estado == 'crit' else 0

        sugerencias.append({
            "pp_id": it["pp_id"],
            "tmpl_id": it["tmpl_id"],
            "grupo_id": it["grupo_id"],
            "marca": it["marca"], "tipo": it["tipo"],
            "entalle": it["entalle"], "tela": it["tela"],
            "modelo": it["modelo"],
            "stock_actual": int(stock),
            "en_transito": int(en_transito),
            "velocidad_dia": round(vel, 2),
            "cobertura_dias": round(cob, 1) if cob is not None else None,
            "cobertura_objetivo": int(cob_efectiva),
            "estado": estado,
            "sugerido_unidades_teorico": round(sug_teorico, 1),
            "lote_minimo": lote,
            # Pendiente de cap a nivel grupo (ETAPA 2). Se sobreescribe abajo.
            "sugerido_pedido": sug_pedido_pre,
            "valor_estimado": round(sug_pedido_pre * it["list_price"], 2),
            "margen_perdido_dia": round(margen_perdido_dia, 2),
            "origen_sugerido": origen,
            "lead_time_dias": LEAD_TIME_DEFAULT,
            "stock_proyectado": round(stock_proy, 1),
            "confianza": confianza,
            "tope_aplicado": False,            # se ajusta en ETAPA 2
            "tope_valor": int(tope_tipo),
            "_list_price": float(it["list_price"]),  # interno para recalcular valor
        })

    # ============================================================
    # ETAPA 2 — Aplicar tope físico a nivel GRUPO (cap duro)
    #
    # Para cada grupo (marca·tipo·entalle·tela):
    #   tope_aplicable_grupo = max(0, tope_tipo - stock_grupo - en_transito_grupo)
    #   si sum(sug_pedido_sku) > tope_aplicable_grupo:
    #       factor = tope_aplicable_grupo / sum_inicial
    #       cada SKU se reduce proporcionalmente, redondeando ABAJO al lote
    # ============================================================
    # Indexar sugerencias por grupo
    suger_por_grupo = {}
    for s in sugerencias:
        suger_por_grupo.setdefault(s["grupo_id"], []).append(s)

    for gid, items_grupo in suger_por_grupo.items():
        if not items_grupo:
            continue
        tipo_nombre = items_grupo[0]["tipo"]
        tope_tipo   = items_grupo[0]["tope_valor"]

        stock_grupo = sum(it["stock_actual"] for it in items_grupo)
        transito_grupo = sum(it["en_transito"] for it in items_grupo)
        sug_inicial = sum(it["sugerido_pedido"] for it in items_grupo)

        tope_aplicable_grupo = max(0, int(tope_tipo) - stock_grupo - transito_grupo)

        if sug_inicial <= tope_aplicable_grupo or sug_inicial == 0:
            continue  # no hay que capar este grupo

        # Hay que capar. Distribuir proporcionalmente entre los SKUs
        # que pidieron algo. Redondeo ABAJO al lote para no exceder el tope.
        lote = items_grupo[0]["lote_minimo"]
        factor = tope_aplicable_grupo / sug_inicial if sug_inicial > 0 else 0.0
        nuevo_total = 0
        for it in items_grupo:
            if it["sugerido_pedido"] <= 0:
                continue
            objetivo = it["sugerido_pedido"] * factor
            nuevo = int(objetivo // lote) * lote  # floor al lote (no excede)
            it["sugerido_pedido"] = nuevo
            it["valor_estimado"] = round(nuevo * it["_list_price"], 2)
            it["tope_aplicado"] = True
            nuevo_total += nuevo

        # Si por el redondeo abajo aún sobra "espacio" en el tope, intentar
        # añadir un lote a los SKUs con MAYOR margen perdido por día (más críticos)
        sobra = tope_aplicable_grupo - nuevo_total
        if sobra >= lote:
            criticos = sorted(
                [it for it in items_grupo if it["sugerido_unidades_teorico"] > it["sugerido_pedido"]],
                key=lambda x: -x["margen_perdido_dia"],
            )
            for it in criticos:
                if sobra < lote:
                    break
                it["sugerido_pedido"] += lote
                it["valor_estimado"] = round(it["sugerido_pedido"] * it["_list_price"], 2)
                sobra -= lote

    # Limpiar campos internos antes de serializar
    for s in sugerencias:
        s.pop("_list_price", None)

    # ============================================================
    # Agrupar por grupo (default) o dejar por modelo
    # ============================================================
    if nivel == "grupo":
        grouped = {}
        for s in sugerencias:
            gid = s["grupo_id"]
            if gid not in grouped:
                grouped[gid] = {
                    "grupo_id": gid,
                    "marca": s["marca"], "tipo": s["tipo"],
                    "entalle": s["entalle"], "tela": s["tela"],
                    "modelo": None,
                    "stock_actual": 0, "en_transito": 0,
                    "velocidad_dia": 0, "cobertura_dias": None,
                    "cobertura_objetivo": s["cobertura_objetivo"],  # del primer SKU; arriba se ajusta
                    "estado": s["estado"],  # se recalcula
                    "sugerido_unidades_teorico": 0,
                    "lote_minimo": s["lote_minimo"],
                    "sugerido_pedido": 0,
                    "valor_estimado": 0,
                    "margen_perdido_dia": 0,
                    "origen_sugerido": s["origen_sugerido"],  # del primer SKU; se decide abajo
                    "lead_time_dias": LEAD_TIME_DEFAULT,
                    "stock_proyectado": 0,
                    "confianza": s["confianza"],
                    # tope: a nivel grupo "true" si CUALQUIER SKU del grupo
                    # tuvo cap. tope_valor uniforme dentro del grupo (mismo tipo).
                    "tope_aplicado": False,
                    "tope_valor": s["tope_valor"],
                    "tope_skus_capados": 0,
                    "_sku_count": 0,
                    "_origenes": {},
                    "_cob_objs": [],
                }
            g = grouped[gid]
            g["stock_actual"] += s["stock_actual"]
            g["en_transito"] += s["en_transito"]
            g["velocidad_dia"] += s["velocidad_dia"]
            g["sugerido_unidades_teorico"] += s["sugerido_unidades_teorico"]
            g["sugerido_pedido"] += s["sugerido_pedido"]
            g["valor_estimado"] += s["valor_estimado"]
            g["margen_perdido_dia"] += s["margen_perdido_dia"]
            g["stock_proyectado"] += s["stock_proyectado"]
            g["_sku_count"] += 1
            # Voto de origen (el más popular gana)
            g["_origenes"][s["origen_sugerido"]] = g["_origenes"].get(s["origen_sugerido"], 0) + 1
            # Cobertura objetivo: máximo del grupo (más conservador a nivel agregado)
            g["_cob_objs"].append(s["cobertura_objetivo"])
            # Tope: si algún SKU fue capado, el grupo lo refleja
            if s["tope_aplicado"]:
                g["tope_aplicado"] = True
                g["tope_skus_capados"] += 1

        items_out = []
        for g in grouped.values():
            g["cobertura_dias"] = round(g["stock_actual"] / g["velocidad_dia"], 1) if g["velocidad_dia"] > 0 else None
            g["estado"] = estado_por_cobertura(g["cobertura_dias"], g["stock_actual"], g["velocidad_dia"])
            g["velocidad_dia"] = round(g["velocidad_dia"], 2)
            g["valor_estimado"] = round(g["valor_estimado"], 2)
            g["margen_perdido_dia"] = round(g["margen_perdido_dia"], 2)
            g["sugerido_unidades_teorico"] = round(g["sugerido_unidades_teorico"], 1)
            g["stock_proyectado"] = round(g["stock_proyectado"], 1)
            g["origen_sugerido"] = max(g["_origenes"], key=g["_origenes"].get) if g["_origenes"] else "ALMACEN"
            # Para mostrar la cobertura del grupo: mediana de los SKUs (representativa)
            cobs = sorted(g.pop("_cob_objs"))
            g["cobertura_objetivo"] = cobs[len(cobs) // 2] if cobs else g["cobertura_objetivo"]
            g.pop("_origenes")
            items_out.append(g)
    else:
        items_out = sugerencias

    # Filtrar por estado si se pidió y ordenar por margen_perdido_dia DESC
    if incluir_set:
        items_out = [it for it in items_out if it["estado"] in incluir_set]
    items_out.sort(key=lambda x: (-(x["margen_perdido_dia"] or 0), -(x["sugerido_pedido"] or 0)))

    # Resumen
    transferibles = sum(1 for it in items_out if it["origen_sugerido"] not in ("ALMACEN", "TALLER") and it["sugerido_pedido"] > 0)
    a_pedir_almacen = sum(1 for it in items_out if it["origen_sugerido"] in ("ALMACEN", "TALLER") and it["sugerido_pedido"] > 0)

    return {
        "tienda": tienda,
        "cobertura_objetivo": cobertura_objetivo,
        "nivel": nivel,
        "items": items_out,
        "resumen": {
            "skus_en_accion": sum(1 for it in items_out if it["sugerido_pedido"] > 0),
            "unidades_total_sugerido": sum(it["sugerido_pedido"] for it in items_out),
            "valor_estimado_total": round(sum(it["valor_estimado"] for it in items_out), 2),
            "transferibles_internos": transferibles,
            "a_pedir_almacen": a_pedir_almacen,
        },
    }


# ============================================================
# 4. /surtido — matriz color×talla de un grupo en (origen, destino)
#
# Para que al pulsar "Transferir" desde GR238 a GM209 el usuario sepa
# QUÉ tallas y colores específicos pedir/transferir. Combina:
#   - Stock por (color, talla) en la tienda ORIGEN (lo que hay para mover)
#   - Velocidad EWMA por (color, talla) en la tienda DESTINO (qué se vende)
#   - Stock por (color, talla) en la tienda DESTINO (qué tiene actualmente)
# Y sugiere cuánto traer por celda (priorizando lo que destino vende y origen tiene).
# ============================================================
@router.get("/surtido")
async def surtido(
    tienda_destino: str = Query(..., description="x_nombre de la tienda destino"),
    tienda_origen: str = Query(..., description="x_nombre de la tienda origen"),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    entalle: Optional[str] = Query(None),
    tela: Optional[str] = Query(None),
    _u: dict = Depends(get_current_user),
):
    """Matriz color×talla para surtido entre origen y destino.

    Solo cubre el grupo (marca, tipo, entalle, tela) recibido. Devuelve filas
    {color, talla, stock_origen, stock_destino, vel_destino, sug_traer}.
    """
    # Filtros de grupo: usamos los TEXTOS de pt.* (auto-match con catálogo).
    # IMPORTANTE: los placeholders empiezan en $2 porque $1 está reservado
    # para la tienda (se pasa primero en cada query).
    grupo_filtros = []
    grupo_params: list = []
    OFFSET = 1  # $1 = tienda
    if marca:
        grupo_params.append(marca)
        grupo_filtros.append(f"COALESCE(ma.nombre, ma_auto.nombre, pt.marca) = ${OFFSET + len(grupo_params)}")
    if tipo:
        grupo_params.append(tipo)
        grupo_filtros.append(f"COALESCE(ti.nombre, ti_auto.nombre, pt.tipo) = ${OFFSET + len(grupo_params)}")
    if entalle:
        grupo_params.append(entalle)
        grupo_filtros.append(f"COALESCE(en.nombre, en_auto.nombre, pt.entalle) = ${OFFSET + len(grupo_params)}")
    if tela:
        grupo_params.append(tela)
        grupo_filtros.append(f"COALESCE(te.nombre, te_auto.nombre, pt.tela) = ${OFFSET + len(grupo_params)}")

    grupo_where = " AND ".join(grupo_filtros) if grupo_filtros else "TRUE"

    # JOIN común para resolver labels de marca/tipo/entalle/tela con auto-match
    JOINS_GRUPO = """
    LEFT JOIN produccion.prod_odoo_productos_enriq pe ON pe.odoo_template_id = pt.odoo_id
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

    # Stock por (color, talla) en una tienda. Usa v_product_variant_flat para
    # los atributos color/talla limpios.
    sql_stock = f"""
    SELECT
        COALESCE(NULLIF(vf.color, ''), '— sin color —') AS color,
        COALESCE(NULLIF(vf.talla, ''), '—') AS talla,
        SUM(q.qty)::int AS stock,
        COUNT(DISTINCT pp.odoo_id) AS skus
    FROM odoo.stock_quant q
    JOIN odoo.product_product pp ON pp.odoo_id = q.product_id AND pp.active = true
    JOIN odoo.product_template pt ON pt.odoo_id = pp.product_tmpl_id AND pt.active = true
    JOIN odoo.stock_location sl ON sl.odoo_id = q.location_id
    JOIN odoo.v_product_variant_flat vf ON vf.product_product_id = pp.odoo_id
    {JOINS_GRUPO}
    WHERE q.qty > 0
      AND sl.x_nombre = $1
      AND sl.usage = 'internal' AND sl.active = true
      AND ({grupo_where})
    GROUP BY 1, 2
    HAVING SUM(q.qty) > 0;
    """

    # Velocidad por (color, talla) en una tienda (EWMA τ=30d sobre W=60d).
    # Misma fórmula corregida: SUM(qty*decay) / (τ*(1−e^(−W/τ))).
    # Filtro sl.usage='internal' AND sl.active=true defensivo.
    sql_vel = f"""
    SELECT
        COALESCE(NULLIF(v.color, ''), '— sin color —') AS color,
        COALESCE(NULLIF(v.talla, ''), '—') AS talla,
        COALESCE(SUM(v.qty * EXP(-EXTRACT(EPOCH FROM (NOW() - v.date_order)) / 86400.0 / {EWMA_DECAY_DAYS})), 0)
          / {EWMA_NORMALIZER_SQL} AS vel
    {VENTA_REAL_FROM}
    JOIN odoo.stock_location sl ON sl.odoo_id = po.location_id
    LEFT JOIN odoo.product_template pt ON pt.odoo_id = v.product_tmpl_id
    {JOINS_GRUPO}
    WHERE v.date_order >= NOW() - INTERVAL '{EWMA_WINDOW_DAYS} days'
      AND v.qty > 0
      AND sl.x_nombre = $1
      AND sl.usage = 'internal' AND sl.active = true
      AND ({grupo_where})
      AND {VENTA_REAL_WHERE}
    GROUP BY 1, 2;
    """

    pool = await get_pool()

    async def _qstock(t):
        async with pool.acquire() as conn:
            return await conn.fetch(sql_stock, t, *grupo_params)

    async def _qvel(t):
        async with pool.acquire() as conn:
            return await conn.fetch(sql_vel, t, *grupo_params)

    stock_origen_rows, stock_destino_rows, vel_destino_rows = await asyncio.gather(
        _qstock(tienda_origen),
        _qstock(tienda_destino),
        _qvel(tienda_destino),
    )

    # Indexar
    so = {(r["color"], r["talla"]): {"stock": int(r["stock"]), "skus": int(r["skus"])} for r in stock_origen_rows}
    sd = {(r["color"], r["talla"]): {"stock": int(r["stock"]), "skus": int(r["skus"])} for r in stock_destino_rows}
    vd = {(r["color"], r["talla"]): float(r["vel"] or 0) for r in vel_destino_rows}

    # Universo: cualquier (color, talla) que aparezca en al menos una de las 3
    keys = set(so.keys()) | set(sd.keys()) | set(vd.keys())

    # Sugerencia por celda: prioriza tallas/colores con velocidad alta en destino
    # y stock disponible en origen. Cobertura objetivo dinámica + restricción de
    # no exceder lo que hay en origen.
    items = []
    for (color, talla) in keys:
        stk_o = so.get((color, talla), {"stock": 0, "skus": 0})["stock"]
        stk_d = sd.get((color, talla), {"stock": 0, "skus": 0})["stock"]
        vel = vd.get((color, talla), 0.0)
        cob_obj = cobertura_efectiva(vel)
        # Cuánto necesita destino para cubrir cob_obj días, descontando lo que ya tiene
        necesita = max(0.0, vel * cob_obj - stk_d)
        # No podemos llevar más de lo que hay en origen
        sugerido = int(min(necesita, stk_o))
        items.append({
            "color": color,
            "talla": talla,
            "stock_origen": stk_o,
            "stock_destino": stk_d,
            "vel_destino": round(vel, 2),
            "cobertura_dias_destino": round(stk_d / vel, 1) if vel > 0 else None,
            "cobertura_objetivo": cob_obj,
            "necesita_destino": round(necesita, 1),
            "sugerido_traer": sugerido,
        })

    # Orden: priorizar lo que aporta más cobertura al destino (vel * sugerido)
    items.sort(key=lambda x: (-x["sugerido_traer"], -x["vel_destino"], x["color"], x["talla"]))

    # Tallas únicas ordenadas (numéricas primero, luego alfa)
    all_tallas = sorted({it["talla"] for it in items})
    numericas = sorted([t for t in all_tallas if t.replace('.', '').isdigit()], key=lambda x: float(x))
    alfa = [t for t in all_tallas if not t.replace('.', '').isdigit()]
    orden_alfa = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'U', 'STD', '—']
    alfa_sorted = sorted(alfa, key=lambda x: (orden_alfa.index(x) if x in orden_alfa else 99, x))
    tallas = numericas + alfa_sorted

    return {
        "tienda_origen": tienda_origen,
        "tienda_destino": tienda_destino,
        "grupo": {"marca": marca, "tipo": tipo, "entalle": entalle, "tela": tela},
        "items": items,
        "tallas": tallas,
        "totales": {
            "stock_origen": sum(it["stock_origen"] for it in items),
            "stock_destino": sum(it["stock_destino"] for it in items),
            "sugerido_traer": sum(it["sugerido_traer"] for it in items),
        },
    }
