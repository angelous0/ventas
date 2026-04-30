"""Alertas configurables + generación de alertas activas.

GET  /api/alertas/config — lista umbrales configurados
PUT  /api/alertas/config/{id} — actualiza umbral_pct / dias_referencia / activa
POST /api/alertas/config/{id}/toggle — conmuta activa on/off
GET  /api/alertas — genera alertas según umbrales activos
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from auth_utils import get_current_user
from db import get_pool
from helpers import row_to_dict

router = APIRouter(prefix="/api")


class AlertaConfigUpdate(BaseModel):
    umbral_pct: Optional[float] = None
    dias_referencia: Optional[int] = None
    activa: Optional[bool] = None


LABELS = {
    "marca_cae": {"titulo": "Marca que cae", "desc": "Avisar cuando una marca cae más de X% vs año anterior."},
    "marca_crece": {"titulo": "Marca que crece", "desc": "Avisar cuando una marca crece más de X% vs año anterior."},
    "entalle_sube": {"titulo": "Entalle en alza", "desc": "Avisar cuando un entalle sube más de X% YTD."},
    "cliente_inactivo": {"titulo": "Cliente inactivo", "desc": "Avisar si un cliente Top no compra hace X días."},
    "tienda_cae": {"titulo": "Tienda que cae", "desc": "Avisar cuando una tienda cae más de X% vs año anterior."},
    "producto_estrella": {"titulo": "Producto estrella", "desc": "Avisar cuando un producto crece más de X% vs año anterior."},
}


@router.get("/alertas/config")
async def config_list(_u: dict = Depends(get_current_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM produccion.prod_alertas_ventas_config ORDER BY tipo")
        items = []
        for r in rows:
            d = row_to_dict(r)
            meta = LABELS.get(d["tipo"], {})
            d["titulo"] = meta.get("titulo", d["tipo"])
            d["descripcion"] = meta.get("desc", "")
            items.append(d)
        return {"items": items}


@router.put("/alertas/config/{cfg_id}")
async def config_update(cfg_id: str, body: AlertaConfigUpdate, _u: dict = Depends(get_current_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        exist = await conn.fetchrow("SELECT id FROM produccion.prod_alertas_ventas_config WHERE id = $1", cfg_id)
        if not exist:
            raise HTTPException(404, "config no encontrada")

        sets = []
        params = []
        if body.umbral_pct is not None:
            params.append(body.umbral_pct); sets.append(f"umbral_pct = ${len(params)}")
        if body.dias_referencia is not None:
            params.append(body.dias_referencia); sets.append(f"dias_referencia = ${len(params)}")
        if body.activa is not None:
            params.append(body.activa); sets.append(f"activa = ${len(params)}")
        if not sets:
            return {"ok": True, "nochange": True}

        sets.append("updated_at = NOW()")
        params.append(cfg_id)
        await conn.execute(
            f"UPDATE produccion.prod_alertas_ventas_config SET {', '.join(sets)} WHERE id = ${len(params)}",
            *params
        )
        return {"ok": True}


@router.post("/alertas/config/{cfg_id}/toggle")
async def config_toggle(cfg_id: str, _u: dict = Depends(get_current_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE produccion.prod_alertas_ventas_config SET activa = NOT activa, updated_at=NOW() WHERE id=$1 RETURNING activa",
            cfg_id
        )
        if not row:
            raise HTTPException(404, "config no encontrada")
        return {"ok": True, "activa": row["activa"]}


@router.get("/alertas")
async def alertas_activas(_u: dict = Depends(get_current_user)):
    """Genera alertas computadas según umbrales activos.

    Implementación simple: solo lee configs activas y arma alertas demo (placeholder).
    La lógica completa (computar métricas reales y cruzar con umbrales) se expande
    en un Paso 9.5 si el usuario lo pide.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM produccion.prod_alertas_ventas_config WHERE activa = true ORDER BY tipo"
        )
        return {"items": [
            {
                "tipo": r["tipo"],
                "umbral_pct": float(r["umbral_pct"]) if r["umbral_pct"] is not None else None,
                "dias_referencia": r["dias_referencia"],
                "mensaje": LABELS.get(r["tipo"], {}).get("titulo", r["tipo"]),
            }
            for r in rows
        ]}
