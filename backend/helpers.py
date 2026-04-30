"""Helpers comunes para el módulo Ventas.

Contiene:
- row_to_dict: serialización de asyncpg.Record
- VENTA_REAL_WHERE / VENTA_REAL_FROM: filtros base "venta real" (excluye canceladas y reservas)
- RESERVA_PENDIENTE_WHERE: filtro para reservas activas
- CLIENTE_SELECT: expresión SQL del cliente efectivo (principal o cuenta_partner)
- ytd_rango: rango de fechas same-day YTD para comparativos multi-año
- dias_transcurridos_anio: días desde 1-ene hasta una fecha
- parse_fecha: parser flexible YYYY-MM-DD -> datetime
"""
from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Optional


# =================================================================
# Serialización de filas
# =================================================================
def row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, datetime):
            d[k] = v.isoformat()
        elif isinstance(v, date):
            d[k] = v.isoformat()
        elif isinstance(v, Decimal):
            d[k] = float(v)
    return d


# =================================================================
# Filtros SQL base (venta real)
# =================================================================
# La vista `odoo.v_pos_line_full` ya trae is_cancelled, reserva, reserva_use_id.
# El JOIN con `odoo.pos_order po` aporta order_cancel y x_cliente_principal.
# IMPORTANTE: el JOIN es `po.odoo_id = v.order_id` (pos_order usa odoo_id como PK).

VENTA_REAL_FROM = """
FROM odoo.v_pos_line_full v
LEFT JOIN odoo.pos_order po ON po.odoo_id = v.order_id
"""

# Palabras prohibidas en el nombre del producto — excluidas de TODOS los reportes.
# Motivo: productos de marketing/regalo/accesorios/errores de precio que no son venta textil real.
# Confirmado con usuario: correa, bolsa, paneton, probador, provador, saco, lapicero, publicitario, envio, envío.
# NO excluidos: productos con sufijo "-LQ" (liquidación) — son ventas reales de saldo.
PALABRAS_EXCLUIDAS = [
    'correa', 'bolsa', 'paneton', 'probador', 'provador', 'saco',
    'lapicero', 'publicitario', 'envio', 'envío',
    'tallero',  # molde/repuesto (ej. Nylon Tallero Pant con 21K stock)
]

# Filtro adicional: excluir productos marcados como "excluido" en la clasificación
# manual de Producción (prod_odoo_productos_enriq.estado = 'excluido').
# Se aplica en helpers que consultan product_template.
PRODUCTO_ESTADO_EXCLUIDO_WHERE = """
NOT EXISTS (
    SELECT 1 FROM produccion.prod_odoo_productos_enriq pe_excl
    WHERE pe_excl.odoo_template_id = v.product_tmpl_id
      AND pe_excl.estado = 'excluido'
)
""".strip()

_patterns_sql = ",".join(f"'%{p}%'" for p in PALABRAS_EXCLUIDAS)
# El NOT IN excluye:
# 1. Productos cuyo nombre contenga alguna palabra prohibida
# 2. Productos con purchase_ok=true AND marca vacía/NULL (basura típica de Odoo:
#    `ddddd`, `.`, `boton1boton1`, `[2026294] ...`, etc.). Se asume que un producto
#    vendible siempre tiene marca asignada en el texto.
PRODUCTO_VALIDO_WHERE = f"""
v.product_tmpl_id NOT IN (
  SELECT odoo_id FROM odoo.product_template
  WHERE name ILIKE ANY (ARRAY[{_patterns_sql}])
     OR (purchase_ok = true AND (marca IS NULL OR marca = ''))
)
""".strip()

# Filtro adicional: evitar doble conteo de NV (state='done') que ya tienen
# una factura/boleta (state='invoiced') con mismo cliente, monto y location ±7 días.
# Caso típico: cliente mayorista reserva con NV crédito → días después se le emite
# Boleta/Factura. La factura cuenta, la NV NO (ya está en la factura).
SIN_DUPLICADO_NV_WHERE = """
NOT (
    po.state = 'done'
    AND EXISTS (
        SELECT 1 FROM odoo.pos_order po2
        WHERE po2.state = 'invoiced'
          AND po2.amount_total = po.amount_total
          AND po2.location_id = po.location_id
          AND COALESCE(po2.x_cliente_principal, po2.partner_id)
              = COALESCE(po.x_cliente_principal, po.partner_id)
          AND po2.date_order BETWEEN po.date_order - INTERVAL '7 days'
                                 AND po.date_order + INTERVAL '7 days'
          AND po2.odoo_id <> po.odoo_id
          AND po2.company_key = po.company_key
    )
)
""".strip()

# Aplicar siempre en WHERE o en AND ...
# Combinación de filtros que define "venta real" en TODO el módulo Ventas.
VENTA_REAL_WHERE = f"""
(v.is_cancelled = false OR v.is_cancelled IS NULL)
AND (v.reserva IS NULL OR v.reserva = false)
AND (v.reserva_use_id = 0 OR v.reserva_use_id IS NULL)
AND (po.order_cancel = false OR po.order_cancel IS NULL)
AND {SIN_DUPLICADO_NV_WHERE}
AND {PRODUCTO_VALIDO_WHERE}
AND {PRODUCTO_ESTADO_EXCLUIDO_WHERE}
""".strip()

# Expresión: cliente efectivo (usa principal si existe, sino cuenta_partner).
CLIENTE_SELECT = "COALESCE(po.x_cliente_principal, v.cuenta_partner_id)"

# Reserva pendiente: la RESERVA está marcada, no se canceló, no se usó aún.
RESERVA_PENDIENTE_WHERE = f"""
v.reserva = true
AND (v.is_cancelled = false OR v.is_cancelled IS NULL)
AND (po.order_cancel = false OR po.order_cancel IS NULL)
AND (v.reserva_use_id = 0 OR v.reserva_use_id IS NULL)
AND {PRODUCTO_VALIDO_WHERE}
""".strip()


# =================================================================
# Rangos temporales
# =================================================================
def ytd_rango(anio: int, hoy: Optional[datetime] = None) -> tuple[datetime, datetime]:
    """Rango (desde, hasta) del `anio` recortado al mismo día-mes que `hoy`.

    Ejemplo: si hoy es 2026-04-19, ytd_rango(2025) devuelve (2025-01-01, 2025-04-19 23:59:59).
    Esto garantiza comparativos justos YTD same-day entre años.

    Para 29-feb en años no bisiestos, cae al 28-feb.
    """
    hoy = hoy or datetime.now()
    desde = datetime(anio, 1, 1)
    try:
        hasta = datetime(anio, hoy.month, hoy.day, 23, 59, 59)
    except ValueError:
        # 29-feb en año no bisiesto → usar último día del mes
        hasta = datetime(anio, hoy.month, 28, 23, 59, 59)
    return desde, hasta


def dias_transcurridos_anio(fecha: Optional[datetime] = None) -> int:
    """Días transcurridos del año hasta `fecha` (inclusive)."""
    fecha = fecha or datetime.now()
    inicio = datetime(fecha.year, 1, 1)
    return (fecha.date() - inicio.date()).days + 1


def parse_fecha(s: Optional[str]) -> Optional[datetime]:
    """Parsea 'YYYY-MM-DD' o 'YYYY-MM-DDTHH:MM:SS' → datetime. None si vacío."""
    if not s:
        return None
    s = s.strip()
    try:
        if "T" in s or " " in s.replace("-", "x", 2):  # tiene hora
            return datetime.fromisoformat(s.replace("Z", ""))
        return datetime.strptime(s, "%Y-%m-%d")
    except Exception:
        return None


def rango_vista(vista: str, desde: Optional[str], hasta: Optional[str],
                hoy: Optional[datetime] = None) -> tuple[datetime, datetime]:
    """Interpreta params de Dashboard → (desde, hasta) datetimes.

    vista: 'ytd' | '7' | '30' | 'custom'
    Para 'custom', usa `desde` y `hasta` (strings YYYY-MM-DD).
    """
    hoy = hoy or datetime.now()
    if vista == "ytd":
        d, h = ytd_rango(hoy.year, hoy)
        return d, h
    if vista == "7":
        h = datetime(hoy.year, hoy.month, hoy.day, 23, 59, 59)
        d = h - timedelta(days=7)
        return d, h
    if vista == "30":
        h = datetime(hoy.year, hoy.month, hoy.day, 23, 59, 59)
        d = h - timedelta(days=30)
        return d, h
    # custom
    d = parse_fecha(desde) or datetime(hoy.year, 1, 1)
    h = parse_fecha(hasta) or datetime(hoy.year, hoy.month, hoy.day, 23, 59, 59)
    # Si `hasta` vino sin hora, extender al final del día
    if h.hour == 0 and h.minute == 0 and h.second == 0:
        h = h.replace(hour=23, minute=59, second=59)
    return d, h
