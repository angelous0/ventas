from fastapi import FastAPI, APIRouter, Query, Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import time
import hashlib
import uuid
from pathlib import Path
from typing import Optional, List
from datetime import datetime, timezone
from decimal import Decimal
from io import BytesIO
from pydantic import BaseModel
import psycopg2
from psycopg2 import pool as pg_pool_module
from contextlib import contextmanager
from emergentintegrations.llm.chat import LlmChat, UserMessage

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB
mongo_url = os.environ['MONGO_URL']
mongo_client = AsyncIOMotorClient(mongo_url)
db = mongo_client[os.environ['DB_NAME']]

# PostgreSQL connection pool
pg_pool = pg_pool_module.ThreadedConnectionPool(
    minconn=1,
    maxconn=5,
    host=os.environ['PG_HOST'],
    port=int(os.environ['PG_PORT']),
    dbname=os.environ['PG_DB'],
    user=os.environ['PG_USER'],
    password=os.environ['PG_PASS'],
    options=f"-c search_path={os.environ.get('PG_SCHEMA', 'odoo')} -c statement_timeout=30000"
)

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Cache ────────────────────────────────────────────────
_cache = {}
CACHE_TTL = 120  # 2 minutes

def _cache_key(sql, params):
    raw = f"{sql}:{params}"
    return hashlib.md5(raw.encode()).hexdigest()

def _cache_clean():
    now = time.time()
    expired = [k for k, v in _cache.items() if now - v['ts'] > CACHE_TTL * 3]
    for k in expired:
        del _cache[k]

# ── Helpers ──────────────────────────────────────────────

@contextmanager
def get_pg():
    conn = pg_pool.getconn()
    try:
        yield conn
    finally:
        pg_pool.putconn(conn)

def query_pg(sql, params=None, use_cache=True):
    if use_cache:
        key = _cache_key(sql, params)
        if key in _cache and time.time() - _cache[key]['ts'] < CACHE_TTL:
            return _cache[key]['data']

    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or [])
            cols = [d[0] for d in cur.description]
            result = []
            for row in cur.fetchall():
                d = {}
                for i, val in enumerate(row):
                    if isinstance(val, Decimal):
                        d[cols[i]] = float(val)
                    elif isinstance(val, datetime):
                        d[cols[i]] = val.isoformat()
                    else:
                        d[cols[i]] = val
                result.append(d)

    if use_cache:
        _cache_clean()
        _cache[key] = {'data': result, 'ts': time.time()}
    return result

# Valid sales filters
VPL_BASE = "(vplf.is_cancelled IS NULL OR vplf.is_cancelled = false) AND (vplf.reserva IS NULL OR vplf.reserva = false)"
PO_BASE = "(po.is_cancel IS NULL OR po.is_cancel = false) AND (po.order_cancel IS NULL OR po.order_cancel = false) AND (po.reserva IS NULL OR po.reserva = false)"

def vpl_from(need_store=False, need_client=False):
    base = "FROM v_pos_line_full vplf"
    base += "\nJOIN product_template pt ON pt.odoo_id = vplf.product_tmpl_id"
    if need_store or need_client:
        base += "\nJOIN pos_order po ON po.odoo_id = vplf.order_id AND po.company_key = vplf.company_key"
    if need_store:
        base += "\nLEFT JOIN stock_location sl ON sl.odoo_id = po.location_id"
    if need_client:
        base += "\nJOIN res_partner rp ON rp.odoo_id = po.partner_id"
    return base

def _add_multi(where, params, field, value_csv):
    """Add IN clause for comma-separated values."""
    vals = [v.strip() for v in value_csv.split(',') if v.strip()]
    if len(vals) == 1:
        where.append(f"{field} = %s")
        params.append(vals[0])
    else:
        ph = ','.join(['%s'] * len(vals))
        where.append(f"{field} IN ({ph})")
        params.extend(vals)

def add_filters(where, params, start_date=None, end_date=None, marca=None, tipo=None, store=None, year=None, years=None, ytd_day=None, date_col="vplf.date_order"):
    if start_date:
        where.append(f"{date_col} >= %s")
        params.append(start_date)
    if end_date:
        where.append(f"{date_col} < %s")
        params.append(end_date)
    if marca:
        _add_multi(where, params, "vplf.marca", marca)
    if tipo:
        _add_multi(where, params, "pt.tipo_resumen", tipo)
    if store:
        _add_multi(where, params, "SPLIT_PART(sl.complete_name, '/', 2)", store)
    if year:
        where.append(f"EXTRACT(YEAR FROM {date_col})::int = %s")
        params.append(int(year))
    if years:
        ph = ','.join(['%s'] * len(years))
        where.append(f"EXTRACT(YEAR FROM {date_col})::int IN ({ph})")
        params.extend([int(y) for y in years])
    if ytd_day:
        where.append(f"TO_CHAR({date_col}, 'MM-DD') <= %s")
        params.append(ytd_day)

# ── Init app tables in PostgreSQL ────────────────────────
def _init_app_tables():
    conn = pg_pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS app_settings (
                    key VARCHAR(100) PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id SERIAL PRIMARY KEY,
                    session_id VARCHAR(100) NOT NULL,
                    role VARCHAR(20) NOT NULL,
                    content TEXT NOT NULL,
                    filters TEXT,
                    ts TIMESTAMP DEFAULT NOW()
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, ts)")
            conn.commit()
    finally:
        pg_pool.putconn(conn)

try:
    _init_app_tables()
    logger.info("App tables initialized in PostgreSQL")
except Exception as e:
    logger.warning(f"Could not init app tables: {e}")

# ── Helpers for app data (settings/chat) via PostgreSQL ──

def _pg_get_setting(key):
    rows = query_pg("SELECT value FROM app_settings WHERE key = %s", [key], use_cache=False)
    return rows[0]['value'] if rows else None

def _pg_set_setting(key, value):
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO app_settings (key, value, updated_at) VALUES (%s, %s, NOW())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            """, [key, value])
            conn.commit()

def _pg_delete_setting(key):
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM app_settings WHERE key = %s", [key])
            conn.commit()

def _pg_save_chat_message(session_id, role, content, filters_str=None):
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO chat_messages (session_id, role, content, filters, ts) VALUES (%s, %s, %s, %s, NOW())
            """, [session_id, role, content, filters_str])
            conn.commit()

def _pg_get_chat_history(session_id):
    return query_pg(
        "SELECT role, content, ts::text as ts FROM chat_messages WHERE session_id = %s ORDER BY ts",
        [session_id], use_cache=False
    )

# ── Endpoints ────────────────────────────────────────────

@api_router.get("/")
def root():
    return {"message": "CRM Reports API", "status": "ok", "sales_filter": "is_cancel=false, order_cancel=false, reserva=false (ventas reales)"}

@api_router.get("/filters")
def get_filters():
    marcas = query_pg("SELECT DISTINCT marca FROM product_template WHERE marca IS NOT NULL AND TRIM(marca) != '' ORDER BY marca")
    tipos = query_pg("SELECT DISTINCT tipo_resumen as tipo FROM product_template WHERE tipo_resumen IS NOT NULL AND TRIM(tipo_resumen) != '' ORDER BY tipo_resumen")
    stores = query_pg("""
        SELECT DISTINCT SPLIT_PART(complete_name, '/', 2) as store_code
        FROM stock_location WHERE usage = 'internal' AND complete_name IS NOT NULL
        ORDER BY store_code
    """)
    years = query_pg(f"SELECT DISTINCT EXTRACT(YEAR FROM date_order)::int as year FROM pos_order po WHERE {PO_BASE} ORDER BY year DESC")
    return {
        "marcas": [r["marca"] for r in marcas],
        "tipos": [r["tipo"] for r in tipos],
        "stores": [r["store_code"] for r in stores if r["store_code"]],
        "years": [r["year"] for r in years]
    }

@api_router.get("/kpis")
def get_kpis(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    need_store = store is not None
    params = []
    where = [VPL_BASE]
    add_filters(where, params, start_date, end_date, marca, tipo, store, ytd_day=ytd_day)
    sql = f"""
        SELECT
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold
        {vpl_from(need_store)}
        WHERE {" AND ".join(where)}
    """
    data = query_pg(sql, params)
    r = data[0] if data else {"total_sales": 0, "order_count": 0, "units_sold": 0}
    r["avg_ticket"] = round(r["total_sales"] / r["order_count"], 2) if r["order_count"] > 0 else 0
    return r

@api_router.get("/sales-trend")
def get_sales_trend(
    year: Optional[int] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    need_store = store is not None
    params = []
    where = [VPL_BASE]
    add_filters(where, params, start_date, end_date, marca, tipo, store, year=year, ytd_day=ytd_day)
    sql = f"""
        SELECT
            EXTRACT(MONTH FROM vplf.date_order)::int as month,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold
        {vpl_from(need_store)}
        WHERE {" AND ".join(where)}
        GROUP BY month ORDER BY month
    """
    return query_pg(sql, params)

@api_router.get("/sales-by-year")
def get_sales_by_year(
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    need_store = store is not None
    params = []
    where = [VPL_BASE]
    add_filters(where, params, marca=marca, tipo=tipo, store=store, ytd_day=ytd_day)
    sql = f"""
        SELECT
            EXTRACT(YEAR FROM vplf.date_order)::int as year,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold,
            ROUND(COALESCE(SUM(vplf.price_subtotal), 0) / NULLIF(COUNT(DISTINCT vplf.order_id), 0), 2) as avg_ticket
        {vpl_from(need_store)}
        WHERE {" AND ".join(where)}
        GROUP BY year ORDER BY year
    """
    return query_pg(sql, params)

@api_router.get("/year-monthly")
def get_year_monthly(
    years: str = Query(...),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    year_list = [int(y.strip()) for y in years.split(',')]
    need_store = store is not None
    params = []
    where = [VPL_BASE]
    add_filters(where, params, marca=marca, tipo=tipo, store=store, years=year_list, ytd_day=ytd_day)
    sql = f"""
        SELECT
            EXTRACT(YEAR FROM vplf.date_order)::int as year,
            EXTRACT(MONTH FROM vplf.date_order)::int as month,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold
        {vpl_from(need_store)}
        WHERE {" AND ".join(where)}
        GROUP BY year, month ORDER BY year, month
    """
    return query_pg(sql, params)

@api_router.get("/sales-by-marca")
def get_sales_by_marca(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    need_store = store is not None
    params = []
    where = [VPL_BASE, "vplf.marca IS NOT NULL"]
    add_filters(where, params, start_date, end_date, tipo=tipo, store=store, year=year, ytd_day=ytd_day)
    sql = f"""
        SELECT
            vplf.marca,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold,
            ROUND(COALESCE(SUM(vplf.price_subtotal), 0) / NULLIF(COUNT(DISTINCT vplf.order_id), 0), 2) as avg_ticket
        {vpl_from(need_store)}
        WHERE {" AND ".join(where)}
        GROUP BY vplf.marca ORDER BY total_sales DESC
    """
    return query_pg(sql, params)

@api_router.get("/sales-by-tipo")
def get_sales_by_tipo(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    marca: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    need_store = store is not None
    params = []
    where = [VPL_BASE, "pt.tipo_resumen IS NOT NULL AND TRIM(pt.tipo_resumen) != ''"]
    add_filters(where, params, start_date, end_date, marca=marca, store=store, year=year, ytd_day=ytd_day)
    sql = f"""
        SELECT
            pt.tipo_resumen as tipo,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold,
            ROUND(COALESCE(SUM(vplf.price_subtotal), 0) / NULLIF(COUNT(DISTINCT vplf.order_id), 0), 2) as avg_ticket
        {vpl_from(need_store)}
        WHERE {" AND ".join(where)}
        GROUP BY pt.tipo_resumen ORDER BY total_sales DESC
    """
    return query_pg(sql, params)

@api_router.get("/marca-trend")
def get_marca_trend(
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    need_store = store is not None
    params = []
    where = [VPL_BASE, "vplf.marca IS NOT NULL"]
    add_filters(where, params, marca=marca, tipo=tipo, store=store, ytd_day=ytd_day)
    sql = f"""
        SELECT
            EXTRACT(YEAR FROM vplf.date_order)::int as year,
            vplf.marca,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold
        {vpl_from(need_store)}
        WHERE {" AND ".join(where)}
        GROUP BY year, vplf.marca ORDER BY year, total_sales DESC
    """
    return query_pg(sql, params)

@api_router.get("/sales-by-store")
def get_sales_by_store(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    params = []
    where = [VPL_BASE]
    add_filters(where, params, start_date, end_date, marca=marca, tipo=tipo, year=year, ytd_day=ytd_day)
    sql = f"""
        SELECT
            SPLIT_PART(sl.complete_name, '/', 2) as store_code,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold,
            ROUND(COALESCE(SUM(vplf.price_subtotal), 0) / NULLIF(COUNT(DISTINCT vplf.order_id), 0), 2) as avg_ticket
        {vpl_from(need_store=True)}
        WHERE {" AND ".join(where)}
        GROUP BY store_code
        HAVING SPLIT_PART(sl.complete_name, '/', 2) IS NOT NULL AND SPLIT_PART(sl.complete_name, '/', 2) != ''
        ORDER BY total_sales DESC
    """
    return query_pg(sql, params)

@api_router.get("/top-clients")
def get_top_clients(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    ytd_day: Optional[str] = Query(None),
    limit: int = Query(20)
):
    params = []
    where = [VPL_BASE]
    add_filters(where, params, start_date, end_date, marca=marca, tipo=tipo, store=store, year=year, ytd_day=ytd_day)
    params.append(limit)
    sql = f"""
        SELECT
            rp.odoo_id as client_id,
            rp.name as client_name,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COALESCE(SUM(vplf.qty), 0) as units_sold,
            ROUND(COALESCE(SUM(vplf.price_subtotal), 0) / NULLIF(COUNT(DISTINCT vplf.order_id), 0), 2) as avg_ticket
        {vpl_from(need_store=store is not None, need_client=True)}
        WHERE {" AND ".join(where)}
        GROUP BY rp.odoo_id, rp.name
        ORDER BY total_sales DESC
        LIMIT %s
    """
    return query_pg(sql, params)

@api_router.get("/client-years")
def get_client_years(
    client_id: int = Query(...),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None)
):
    params = []
    where = [VPL_BASE, "rp.odoo_id = %s"]
    params.append(client_id)
    add_filters(where, params, marca=marca, tipo=tipo, store=store)
    sql = f"""
        SELECT
            EXTRACT(YEAR FROM vplf.date_order)::int as year,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold
        {vpl_from(need_store=store is not None, need_client=True)}
        WHERE {" AND ".join(where)}
        GROUP BY year ORDER BY year
    """
    return query_pg(sql, params)

@api_router.get("/export/excel")
def export_excel(
    report: str = Query("sales-by-year"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    store: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    import openpyxl
    from openpyxl.styles import Font

    wb = openpyxl.Workbook()
    ws = wb.active
    bold = Font(bold=True)

    if report == "sales-by-year":
        data = get_sales_by_year(marca=marca, tipo=tipo, store=store, ytd_day=ytd_day)
        ws.title = "Ventas por Ano"
        headers = ["Ano", "Total Ventas (S/)", "Ordenes", "Unidades", "Ticket Promedio (S/)"]
        ws.append(headers)
        for row in data:
            ws.append([row["year"], row["total_sales"], row["order_count"], row["units_sold"], row["avg_ticket"]])

    elif report == "sales-by-marca":
        data = get_sales_by_marca(start_date=start_date, end_date=end_date, tipo=tipo, store=store, year=year, ytd_day=ytd_day)
        ws.title = "Ventas por Marca"
        headers = ["Marca", "Total Ventas (S/)", "Ordenes", "Unidades", "Ticket Promedio (S/)"]
        ws.append(headers)
        for row in data:
            ws.append([row["marca"], row["total_sales"], row["order_count"], row["units_sold"], row["avg_ticket"]])

    elif report == "sales-by-tipo":
        data = get_sales_by_tipo(start_date=start_date, end_date=end_date, marca=marca, store=store, year=year, ytd_day=ytd_day)
        ws.title = "Ventas por Tipo"
        headers = ["Tipo", "Total Ventas (S/)", "Ordenes", "Unidades", "Ticket Promedio (S/)"]
        ws.append(headers)
        for row in data:
            ws.append([row["tipo"], row["total_sales"], row["order_count"], row["units_sold"], row["avg_ticket"]])

    elif report == "sales-by-store":
        data = get_sales_by_store(start_date=start_date, end_date=end_date, marca=marca, tipo=tipo, year=year, ytd_day=ytd_day)
        ws.title = "Ventas por Tienda"
        headers = ["Tienda", "Total Ventas (S/)", "Ordenes", "Unidades", "Ticket Promedio (S/)"]
        ws.append(headers)
        for row in data:
            ws.append([row["store_code"], row["total_sales"], row["order_count"], row["units_sold"], row["avg_ticket"]])

    elif report == "top-clients":
        data = get_top_clients(start_date=start_date, end_date=end_date, marca=marca, tipo=tipo, store=store, year=year, ytd_day=ytd_day)
        ws.title = "Top Clientes"
        headers = ["Cliente", "Total Ventas (S/)", "Ordenes", "Unidades", "Ticket Promedio (S/)"]
        ws.append(headers)
        for row in data:
            ws.append([row["client_name"], row["total_sales"], row["order_count"], row["units_sold"], row["avg_ticket"]])
    else:
        ws.append(["Reporte no encontrado"])

    for cell in ws[1]:
        cell.font = bold
    for col in ws.columns:
        max_len = max(len(str(c.value or "")) for c in col)
        ws.column_dimensions[col[0].column_letter].width = min(max_len + 4, 30)

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.document",
        headers={"Content-Disposition": f"attachment; filename=reporte_{report}.xlsx"}
    )

@api_router.get("/store-timeline")
def get_store_timeline(
    granularity: str = Query("month"),
    store: Optional[str] = Query(None),
    marca: Optional[str] = Query(None),
    tipo: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    ytd_day: Optional[str] = Query(None)
):
    params = []
    where = [VPL_BASE]
    add_filters(where, params, marca=marca, tipo=tipo, store=store, year=year, ytd_day=ytd_day)

    if granularity == "day":
        time_expr = "vplf.date_order::date"
        order_expr = "period"
    elif granularity == "week":
        time_expr = "DATE_TRUNC('week', vplf.date_order)::date"
        order_expr = "period"
    else:
        time_expr = "DATE_TRUNC('month', vplf.date_order)::date"
        order_expr = "period"

    sql = f"""
        SELECT
            {time_expr} as period,
            SPLIT_PART(sl.complete_name, '/', 2) as store_code,
            COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
            COUNT(DISTINCT vplf.order_id) as order_count,
            COALESCE(SUM(vplf.qty), 0) as units_sold
        {vpl_from(need_store=True)}
        WHERE {" AND ".join(where)}
            AND SPLIT_PART(sl.complete_name, '/', 2) IS NOT NULL
            AND SPLIT_PART(sl.complete_name, '/', 2) != ''
        GROUP BY period, store_code
        ORDER BY {order_expr}, store_code
    """
    rows = query_pg(sql, params)
    for r in rows:
        if r.get('period'):
            r['period'] = r['period'][:10] if isinstance(r['period'], str) else r['period']
    return rows

# ── Chat / AI Assistant (SQL-powered) ────────────────────

import json as json_mod
import re as re_mod

DB_SCHEMA_PROMPT = """Eres un experto analista de ventas de Ambission Industries S.A.C. (retail de ropa en Perú).
Tienes acceso directo a una base de datos PostgreSQL con ventas reales del POS. FECHA ACTUAL: {current_date}. Año actual: {current_year}.

IMPORTANTE — COMPRENSIÓN DEL LENGUAJE:
Los usuarios escriben en español coloquial, con errores ortográficos y abreviaciones. ANTES de generar SQL:
1. Interpreta el mensaje como español natural. Ejemplos de correcciones comunes:
   - "madame" → "mándame" (envíame/dame)
   - "damelo" → "dámelo" (dame eso)
   - "cueles" → "cuáles"
   - "quisera" → "quisiera"
   - "vendio" → "vendió"
   - "tiena" → "tienda"
   - "cuanto" → "cuánto"
2. NO confundas palabras del español con nombres de marcas/productos. Las únicas marcas válidas están listadas abajo.
3. Si hay ambigüedad, prioriza la interpretación como español natural.

ESQUEMA DE LA BASE DE DATOS:

Vista principal: v_pos_line_full (alias: vplf) — cada fila es una línea de venta
  - date_order (timestamp) — fecha de la venta
  - order_id (int) — ID de la orden (una orden puede tener varias líneas)
  - qty (numeric) — cantidad vendida
  - price_unit (numeric) — precio unitario
  - price_subtotal (numeric) — subtotal de la línea (precio * qty - descuento)
  - discount (numeric) — porcentaje de descuento
  - marca (text) — marca del producto
  - tipo (text) — tipo de producto
  - tela (text) — tipo de tela
  - entalle (text) — tipo de entalle/corte
  - talla (text) — talla
  - color (text) — color del producto
  - barcode (text) — código de barras
  - product_tmpl_id (int) — FK a product_template
  - product_id (int) — ID del producto
  - is_cancelled (boolean) — si la venta fue cancelada
  - reserva (boolean) — si es una reserva
  - vendedor_name (text) — nombre del vendedor
  - linea_negocio_nombre (text) — línea de negocio
  - x_pagos (text) — método de pago

Tabla: product_template (alias: pt) — JOIN con pt.odoo_id = vplf.product_tmpl_id
  - name (text) — nombre del producto
  - tipo_resumen (text) — tipo resumido del producto
  - marca, tipo, tela, entalle — atributos del producto
  - list_price (numeric) — precio de lista
  - linea_negocio (text) — línea de negocio

Tabla: pos_order (alias: po) — JOIN con po.odoo_id = vplf.order_id AND po.company_key = vplf.company_key
  - partner_id (int) — FK a res_partner (cliente)
  - location_id (int) — FK a stock_location (tienda)

Tabla: stock_location (alias: sl) — JOIN con sl.odoo_id = po.location_id
  - complete_name (text) — usar SPLIT_PART(sl.complete_name, '/', 2) para obtener código de tienda

Tabla: res_partner (alias: rp) — JOIN con rp.odoo_id = po.partner_id
  - name (text) — nombre del cliente

VALORES VÁLIDOS (usar exactamente estos en los filtros WHERE):
- MARCAS: AMBISSION, BOOSH, ELEMENT DENIM, ELEMENT PREMIUM, EP Studio, PSICOSIS, QEPO, REDDOOR, SPACE
- ENTALLES: Baggy, Baggy Cargo, Bermuda, Bermuda Cargo, Boxi Fit, Boxy Fit, Jogger, Jogger Cargo, Mom Jeans, Oversize, Oversize Cargo, Pitillo, Regular, Semi Extra, Semipitillo, Semipitillo Cargo, Skinny, Slim, Super Baggy, Torero, Unico
- TELAS: Algodón, Catania, Charlot, Comfort, Cordelina, Corduroy, Cortaviento, Denim, Denim Mate, Dray Fit, Drill, Drill Rigido, Franela, Interfil, Jogg, Licrado, Moret, Paper Touch, Popelina, Reppel, Rigido, Satinado, Suede, Tencel, Tricot, Wafer, Wafer Pike
- TIPOS (pt.tipo_resumen): Bermuda, Bermuda Baggy, Bermuda Cargo, Biviri, Blazer, Bomber, Boxer, Camisa, Camisaco, Casaca, Casaca Denim, Chaleco, Correa, Jogger, Pantalon, Pantalon Cargo, Pantalon Denim, Pantalon Drill, Polo, Polo Basico, Polo Estampado, Short, Short Denim, Short Drill, Torero, Torero Drill
- TIENDAS (código de tienda): AP, BOSGA, GAM207, GAM218, GM209, GR238, GRA55, VENTA, VTALL

REGLAS OBLIGATORIAS PARA SQL:
1. SIEMPRE filtrar ventas reales: (vplf.is_cancelled IS NULL OR vplf.is_cancelled = false) AND (vplf.reserva IS NULL OR vplf.reserva = false)
2. Para tiendas: JOIN pos_order po ON po.odoo_id = vplf.order_id AND po.company_key = vplf.company_key, luego LEFT JOIN stock_location sl ON sl.odoo_id = po.location_id
3. Para clientes: JOIN pos_order y luego JOIN res_partner rp ON rp.odoo_id = po.partner_id
4. Para tipo de producto resumido: JOIN product_template pt ON pt.odoo_id = vplf.product_tmpl_id y usar pt.tipo_resumen
5. Solo SELECT (lectura). NUNCA INSERT, UPDATE, DELETE, DROP, ALTER.
6. LIMIT máximo 50 filas.
7. Montos en Soles (S/).
8. "Este año" = {current_year}, "año pasado" = {prev_year}
9. Si el usuario menciona un valor (marca, entalle, tela, tipo) que NO existe en VALORES VÁLIDOS, responde con ```sql SELECT 'NO_EXISTE' as error``` y nada más.
10. Usar ILIKE para búsquedas flexibles de color y nombre de cliente/producto.
11. SIEMPRE usar el alias de tabla (vplf., pt., po., sl., rp.) en TODAS las columnas, incluyendo GROUP BY, ORDER BY y WHERE. Ejemplo: GROUP BY vplf.entalle, no GROUP BY entalle.

INSTRUCCIONES:
- Cuando el usuario haga una pregunta, genera UNA consulta SQL que obtenga los datos necesarios.
- Responde SOLO con el SQL dentro de un bloque ```sql ... ```
- No agregues explicación, solo el SQL."""

RESPONSE_PROMPT = """Eres un experto analista de ventas de Ambission Industries S.A.C. (retail de ropa en Perú).
FECHA ACTUAL: {current_date}. Año actual: {current_year}.

El usuario preguntó: "{question}"

Se ejecutó esta consulta SQL y estos son los resultados:
{results}

Responde en español de forma clara, concisa y analítica. Usa formato con separadores de miles y S/ para montos.
Si los datos muestran tendencias o comparaciones, incluye insights de negocio relevantes.
No muestres el SQL al usuario. Responde como si fueras un analista presentando un reporte.
Si no hay resultados o hay un error, indica amablemente qué pasó.
Si el resultado es 'NO_EXISTE', indica al usuario que ese valor no existe en la base de datos y muestra las opciones válidas que conoces.
Las marcas válidas son: AMBISSION, BOOSH, ELEMENT DENIM, ELEMENT PREMIUM, EP Studio, PSICOSIS, QEPO, REDDOOR, SPACE."""


def _extract_sql(text):
    """Extract SQL from LLM response."""
    match = re_mod.search(r'```sql\s*(.*?)\s*```', text, re_mod.DOTALL)
    if match:
        return match.group(1).strip()
    match = re_mod.search(r'```\s*(SELECT.*?)\s*```', text, re_mod.DOTALL | re_mod.IGNORECASE)
    if match:
        return match.group(1).strip()
    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    sql_lines = [l for l in lines if l.upper().startswith(('SELECT', 'WITH'))]
    if sql_lines:
        idx = lines.index(sql_lines[0])
        return '\n'.join(lines[idx:])
    return None

def _safe_sql(sql):
    """Validate SQL is read-only."""
    upper = sql.upper().strip()
    forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC']
    for word in forbidden:
        if re_mod.search(r'\b' + word + r'\b', upper):
            return False
    return upper.startswith('SELECT') or upper.startswith('WITH')

def _execute_read_query(sql):
    """Execute a read-only SQL query and return results as formatted string."""
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SET statement_timeout = '15s'")
            cur.execute(sql)
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
            result = []
            for row in rows:
                d = {}
                for i, val in enumerate(row):
                    if isinstance(val, Decimal):
                        d[cols[i]] = float(val)
                    elif isinstance(val, datetime):
                        d[cols[i]] = val.strftime('%Y-%m-%d %H:%M')
                    else:
                        d[cols[i]] = val
                result.append(d)
            return result


def _detect_chart(query_results, question):
    """Auto-detect if results are chartable and determine chart type + config."""
    if not query_results or len(query_results) < 2:
        return None

    cols = list(query_results[0].keys())
    if len(cols) < 2:
        return None

    # Identify label column (first text column) and numeric columns
    label_col = None
    numeric_cols = []
    for col in cols:
        sample_vals = [r.get(col) for r in query_results[:5] if r.get(col) is not None]
        if sample_vals and all(isinstance(v, (int, float)) for v in sample_vals):
            numeric_cols.append(col)
        elif sample_vals and not label_col:
            label_col = col

    if not label_col or not numeric_cols:
        return None

    # Determine chart type based on data patterns
    q_lower = question.lower()
    has_time = any(w in label_col.lower() for w in ['mes', 'month', 'fecha', 'date', 'year', 'año', 'dia', 'day', 'semana', 'week', 'periodo', 'period'])
    has_time_q = any(w in q_lower for w in ['por mes', 'mensual', 'por dia', 'diario', 'tendencia', 'evolucion', 'comparar mes', 'por año'])

    if has_time or has_time_q:
        chart_type = "line"
    elif len(query_results) <= 8:
        chart_type = "bar"
    else:
        chart_type = "bar"

    # Build chart data (limit to 30 rows)
    MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
    chart_data = []
    for row in query_results[:30]:
        raw_label = str(row.get(label_col, ''))
        # Format date labels
        if has_time and len(raw_label) >= 10:
            try:
                parts = raw_label[:10].split('-')
                if len(parts) == 3:
                    yr, mo, dy = int(parts[0]), int(parts[1]), int(parts[2])
                    if dy == 1 and label_col.lower() in ['mes', 'month', 'periodo', 'period', 'fecha']:
                        raw_label = f"{MESES[mo-1]} {yr}"
                    else:
                        raw_label = f"{dy}/{mo}/{yr}"
            except:
                pass
        d = {"label": raw_label}
        for nc in numeric_cols[:3]:
            d[nc] = row.get(nc, 0)
        chart_data.append(d)

    return {
        "type": chart_type,
        "data": chart_data,
        "labelKey": "label",
        "dataKeys": numeric_cols[:3],
        "labelName": label_col,
    }


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    filters: Optional[dict] = None

class ChatResponse(BaseModel):
    response: str
    session_id: str
    chart: Optional[dict] = None

chat_sessions = {}

@api_router.post("/chat")
async def chat_endpoint(req: ChatRequest):
    session_id = req.session_id or str(uuid.uuid4())
    filters = req.filters or {}
    current_year = datetime.now().year

    # Check for custom API key
    custom_key = _pg_get_setting("openai_api_key")
    api_key = custom_key if custom_key else os.environ['EMERGENT_LLM_KEY']

    # Build filter context for SQL generation
    filter_hint = ""
    if filters.get('marca'):
        filter_hint += f"\nFiltro activo — marca: {filters['marca']} (agregar WHERE vplf.marca IN (...))"
    if filters.get('tipo'):
        filter_hint += f"\nFiltro activo — tipo: {filters['tipo']} (agregar WHERE pt.tipo_resumen IN (...))"
    if filters.get('store'):
        filter_hint += f"\nFiltro activo — tienda: {filters['store']} (agregar WHERE SPLIT_PART(sl.complete_name, '/', 2) IN (...))"

    # Step 1: Generate SQL
    sql_system = DB_SCHEMA_PROMPT.format(
        current_date=datetime.now().strftime('%d/%m/%Y'),
        current_year=current_year,
        prev_year=current_year - 1
    )
    if filter_hint:
        sql_system += f"\n\nFILTROS DEL USUARIO (aplicar en la consulta):{filter_hint}"

    sql_chat = LlmChat(
        api_key=api_key,
        session_id=f"{session_id}_sql_{uuid.uuid4().hex[:8]}",
        system_message=sql_system
    ).with_model("openai", "gpt-4o-mini")

    sql_response = await sql_chat.send_message(UserMessage(text=req.message))
    generated_sql = _extract_sql(sql_response)

    if not generated_sql or not _safe_sql(generated_sql):
        logger.warning(f"Could not extract safe SQL: {sql_response[:200]}")
        response_text = "No pude generar una consulta válida para esa pregunta. ¿Podrías reformularla?"
        chart_data = None
    else:
        # Step 2: Execute SQL
        query_results = []
        try:
            logger.info(f"Executing AI SQL: {generated_sql[:200]}")
            query_results = _execute_read_query(generated_sql)
            results_str = json_mod.dumps(query_results, ensure_ascii=False, default=str)
            if len(results_str) > 8000:
                results_str = results_str[:8000] + "... (truncado)"
        except Exception as e:
            logger.error(f"SQL execution error: {e}")
            results_str = f"Error al ejecutar la consulta: {str(e)}"

        # Detect chart
        chart_data = _detect_chart(query_results, req.message)

        # Step 3: Format response
        resp_system = RESPONSE_PROMPT.format(
            current_date=datetime.now().strftime('%d/%m/%Y'),
            current_year=current_year,
            question=req.message,
            results=results_str
        )

        resp_chat = LlmChat(
            api_key=api_key,
            session_id=f"{session_id}_resp_{uuid.uuid4().hex[:8]}",
            system_message=resp_system
        ).with_model("openai", "gpt-4o-mini")

        response_text = await resp_chat.send_message(UserMessage(text="Presenta los resultados de forma clara y analítica."))

    # Save to PostgreSQL
    filters_str = json_mod.dumps(filters) if filters else None
    _pg_save_chat_message(session_id, "user", req.message, filters_str)
    _pg_save_chat_message(session_id, "assistant", response_text)

    return ChatResponse(response=response_text, session_id=session_id, chart=chart_data)

@api_router.get("/chat/history")
def get_chat_history(session_id: str = Query(...)):
    return _pg_get_chat_history(session_id)

@api_router.post("/chat/new")
async def new_chat_session():
    session_id = str(uuid.uuid4())
    return {"session_id": session_id}

@api_router.get("/settings/api-key")
def get_api_key_status():
    value = _pg_get_setting("openai_api_key")
    if value:
        masked = value[:7] + "..." + value[-4:]
        return {"has_key": True, "masked": masked}
    return {"has_key": False, "masked": None}

@api_router.post("/settings/api-key")
def save_api_key(req: dict):
    api_key = req.get("api_key", "").strip()
    if not api_key:
        _pg_delete_setting("openai_api_key")
        chat_sessions.clear()
        return {"status": "removed"}
    _pg_set_setting("openai_api_key", api_key)
    chat_sessions.clear()
    return {"status": "saved"}

@api_router.get("/cache/clear")
def clear_cache():
    _cache.clear()
    return {"message": "Cache cleared"}

# Include router and CORS
app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    mongo_client.close()
    pg_pool.closeall()
