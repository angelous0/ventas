"""Proyección de cierre del año (modo lineal y estacional)."""
from fastapi import APIRouter, Depends, Query
from typing import Optional
from datetime import datetime

from auth_utils import get_current_user
from db import get_pool
from helpers import (
    VENTA_REAL_FROM, VENTA_REAL_WHERE,
    ytd_rango, dias_transcurridos_anio,
)

router = APIRouter(prefix="/api")


@router.get("/ventas/proyeccion")
async def proyeccion(
    modo: str = Query("estacional", description="lineal|estacional"),
    company_key: Optional[str] = None,
    location_id: Optional[int] = None,
    _u: dict = Depends(get_current_user),
):
    hoy = datetime.now()
    pool = await get_pool()
    async with pool.acquire() as conn:

        async def _ventas(d, h):
            params = [d, h]
            where = ["v.date_order >= $1", "v.date_order <= $2", VENTA_REAL_WHERE]
            if company_key and company_key != "all":
                params.append(company_key); where.append(f"v.company_key = ${len(params)}")
            if location_id:
                params.append(location_id); where.append(f"po.location_id = ${len(params)}")
            sql = f"""
            SELECT COALESCE(SUM(amount_total), 0)::numeric(14,2) AS ventas
            FROM (
                SELECT DISTINCT v.order_id, po.amount_total
                {VENTA_REAL_FROM}
                WHERE {' AND '.join(where)}
            ) t;
            """
            row = await conn.fetchrow(sql, *params)
            return float(row["ventas"]) if row else 0.0

        # Ventas YTD del año actual
        d_ytd, h_ytd = ytd_rango(hoy.year, hoy)
        ventas_ytd = await _ventas(d_ytd, h_ytd)

        # Proyección lineal
        dias_transcurridos = dias_transcurridos_anio(hoy)
        proyeccion_lineal = ventas_ytd / dias_transcurridos * 365 if dias_transcurridos > 0 else 0

        # Proyección estacional: promedio del ratio (YTD / total_año) de últimos 3 años
        ratios = []
        for offset in range(1, 4):
            anio_prev = hoy.year - offset
            d_ytd_prev, h_ytd_prev = ytd_rango(anio_prev, hoy)
            v_ytd_prev = await _ventas(d_ytd_prev, h_ytd_prev)
            # Ventas totales del año completo anio_prev
            d_total_prev = datetime(anio_prev, 1, 1)
            h_total_prev = datetime(anio_prev, 12, 31, 23, 59, 59)
            v_total_prev = await _ventas(d_total_prev, h_total_prev)
            if v_total_prev > 0:
                ratios.append(v_ytd_prev / v_total_prev)

        pct_estacional = sum(ratios) / len(ratios) if ratios else None
        proyeccion_estacional = (ventas_ytd / pct_estacional) if pct_estacional and pct_estacional > 0 else None

        # Ventas del año anterior completo para comparación
        anio_prev1 = hoy.year - 1
        v_anio_prev = await _ventas(datetime(anio_prev1, 1, 1), datetime(anio_prev1, 12, 31, 23, 59, 59))

        def var_vs_prev(proy):
            if not proy or v_anio_prev <= 0:
                return None
            return round((proy - v_anio_prev) / v_anio_prev * 100, 2)

        return {
            "modo": modo,
            "hoy": hoy.date().isoformat(),
            "ventas_ytd": round(ventas_ytd, 2),
            "dias_transcurridos": dias_transcurridos,
            "proyeccion_lineal": round(proyeccion_lineal, 2),
            "proyeccion_estacional": round(proyeccion_estacional, 2) if proyeccion_estacional else None,
            "pct_historico_ytd": round(pct_estacional * 100, 2) if pct_estacional else None,
            "ventas_anio_anterior_cerrado": round(v_anio_prev, 2),
            "var_lineal_vs_anio_anterior_pct": var_vs_prev(proyeccion_lineal),
            "var_estacional_vs_anio_anterior_pct": var_vs_prev(proyeccion_estacional),
        }
