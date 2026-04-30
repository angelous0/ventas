"""Status y disparo manual de sincronización con Odoo.

Lee el estado del scheduler que está en el módulo Odoo (puerto 8002).
Permite disparar syncs manuales desde Ventas sin tener que ir al módulo Odoo.
"""
import os
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import aiohttp

from auth_utils import get_current_user
from db import get_pool

router = APIRouter(prefix="/api/sync")

ODOO_BACKEND = os.environ.get("ODOO_BACKEND_URL", "http://127.0.0.1:8002")

# Jobs relevantes para Ventas, en orden de prioridad de ejecución.
# POS_ORDERS primero porque es lo más importante para Ventas.
# STOCK_QUANTS al final porque es el más pesado (millones de filas).
JOBS_VENTAS = [
    {"code": "POS_ORDERS", "label": "Ventas POS"},
    {"code": "PRODUCTS", "label": "Productos"},
    {"code": "RES_PARTNER", "label": "Clientes"},
    {"code": "STOCK_LOCATIONS", "label": "Tiendas"},
    {"code": "ATTRIBUTES", "label": "Tallas / colores"},
    {"code": "STOCK_QUANTS", "label": "Stock"},
    {"code": "STOCK_MOVE", "label": "Transferencias"},
]


def _format_freshness(last_run: Optional[datetime]) -> tuple[str, str]:
    """Devuelve (label, severity) según hace cuánto fue last_run."""
    if last_run is None:
        return ("Nunca", "danger")
    now = datetime.now(timezone.utc)
    delta = now - last_run
    h = delta.total_seconds() / 3600
    if h < 2:
        return (f"hace {int(delta.total_seconds() / 60)} min", "ok")
    if h < 26:
        return (f"hace {int(h)} h", "ok")
    days = int(h / 24)
    sev = "warn" if days <= 2 else "danger"
    return (f"hace {days} días", sev)


@router.get("/status")
async def sync_status(_u: dict = Depends(get_current_user)):
    """Estado actual de los jobs de sincronización con Odoo."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT job_code, schedule_type, run_time, enabled,
                      last_run_at, last_success_at, last_error
               FROM odoo.sync_job
               WHERE job_code = ANY($1)
               ORDER BY array_position($1, job_code)""",
            [j["code"] for j in JOBS_VENTAS],
        )
        by_code = {r["job_code"]: dict(r) for r in rows}

    items = []
    pos_last = None
    for j in JOBS_VENTAS:
        r = by_code.get(j["code"])
        if not r:
            continue
        last_run = r["last_run_at"]
        if j["code"] == "POS_ORDERS":
            pos_last = last_run
        label, sev = _format_freshness(last_run)
        items.append({
            "job_code": j["code"],
            "label": j["label"],
            "schedule_type": r["schedule_type"],
            "run_time_utc": r["run_time"].strftime("%H:%M") if r["run_time"] else None,
            "enabled": r["enabled"],
            "last_run_at": last_run.isoformat() if last_run else None,
            "last_success_at": r["last_success_at"].isoformat() if r["last_success_at"] else None,
            "last_error": r["last_error"],
            "freshness": label,
            "severity": sev,
        })

    # Ventas freshness global
    label_overall, sev_overall = _format_freshness(pos_last)
    return {
        "items": items,
        "pos_last_run_at": pos_last.isoformat() if pos_last else None,
        "ventas_freshness": label_overall,
        "ventas_severity": sev_overall,
    }


class TriggerInput(BaseModel):
    jobs: Optional[List[str]] = None  # default: VENTAS jobs


@router.post("/trigger")
async def sync_trigger(body: TriggerInput, _u: dict = Depends(get_current_user)):
    """Dispara sync manual de los jobs de Ventas.

    Llama al backend Odoo en localhost:8002. Espera hasta 5 min por job.
    """
    job_codes = body.jobs if body.jobs else [j["code"] for j in JOBS_VENTAS]

    resultados = []
    # Timeout amplio por job (30 min). Para STOCK_QUANTS puede ser largo.
    timeout = aiohttp.ClientTimeout(total=1800)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for code in job_codes:
            t0 = datetime.now()
            # Reintentos cortos si "otra sincronización en curso"
            attempts = 0
            data = None
            err = None
            while attempts < 12:  # hasta 6 min de espera total para liberar lock
                attempts += 1
                try:
                    async with session.post(
                        f"{ODOO_BACKEND}/api/sync/run",
                        json={"job_code": code, "mode": "incremental", "target": "ALL"},
                    ) as resp:
                        data = await resp.json()
                        msg = (data or {}).get("message", "")
                        if "en curso" in msg.lower() or "running" in msg.lower():
                            await asyncio.sleep(30)
                            continue
                        break
                except Exception as e:
                    err = str(e)
                    break

            elapsed = (datetime.now() - t0).total_seconds()
            if data is not None:
                ok = data.get("success", False)
                rows = sum(r.get("rows", 0) for r in data.get("results", []))
                resultados.append({
                    "job_code": code,
                    "ok": ok,
                    "rows": rows,
                    "duracion_s": round(elapsed, 1),
                    "mensaje": data.get("message", ""),
                })
            else:
                resultados.append({
                    "job_code": code,
                    "ok": False,
                    "rows": 0,
                    "duracion_s": round(elapsed, 1),
                    "mensaje": f"Error: {(err or 'sin respuesta')[:200]}",
                })

    return {"resultados": resultados}
