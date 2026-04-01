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

# ── Chat / AI Assistant ──────────────────────────────────

SYSTEM_PROMPT_BASE = """Eres un experto analista de ventas de Ambission Industries S.A.C., una empresa peruana de retail de ropa.
Tienes acceso a datos de ventas reales del sistema POS (punto de venta). Los datos ya excluyen cancelaciones y reservas.

FECHA ACTUAL: {current_date}. El año actual es {current_year}.

Campos disponibles:
- Ventas en Soles (S/)
- Ordenes/transacciones
- Unidades vendidas
- Ticket promedio
- Marcas de productos
- Tipos de productos (tipo_resumen)
- Tiendas/puntos de venta
- Clientes
- Datos desde 2018 hasta {current_year}

Responde siempre en español. Sé conciso, analítico y orientado a insights de negocio.
Cuando presentes datos numéricos, usa formato con separadores de miles y S/ para montos.
Usa los datos proporcionados en el contexto para responder. No inventes datos.
Si el usuario pregunta por "este año", se refiere a {current_year}. Si pregunta por "el año pasado", es {prev_year}."""

def _gather_context(filters):
    """Query relevant data to give the AI context based on active filters."""
    fp_marca = filters.get('marca')
    fp_tipo = filters.get('tipo')
    fp_store = filters.get('store')
    current_year = datetime.now().year
    prev_year = current_year - 1

    context_parts = []

    # Filters info
    filter_info = []
    if fp_marca:
        filter_info.append(f"Marca: {fp_marca}")
    if fp_tipo:
        filter_info.append(f"Tipo: {fp_tipo}")
    if fp_store:
        filter_info.append(f"Tienda: {fp_store}")
    if filter_info:
        context_parts.append(f"Filtros activos: {', '.join(filter_info)}")
    else:
        context_parts.append("Filtros activos: Ninguno (datos globales)")

    need_store = fp_store is not None

    def _build_where():
        w = [VPL_BASE]
        p = []
        add_filters(w, p, marca=fp_marca, tipo=fp_tipo, store=fp_store)
        return w, p

    # Sales by year (all years)
    try:
        w, p = _build_where()
        sql = f"""
            SELECT EXTRACT(YEAR FROM vplf.date_order)::int as year,
                   COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
                   COUNT(DISTINCT vplf.order_id) as order_count,
                   COALESCE(SUM(vplf.qty), 0) as units_sold
            {vpl_from(need_store)}
            WHERE {" AND ".join(w)}
            GROUP BY year ORDER BY year
        """
        by_year = query_pg(sql, p)
        years_str = " | ".join([f"{r['year']}: S/{r['total_sales']:,.2f} ({r['order_count']} ord, {r['units_sold']:.0f} uds)" for r in by_year])
        context_parts.append(f"Ventas anuales: {years_str}")
    except Exception as e:
        logger.error(f"Context year query error: {e}")

    # Monthly trend current year
    try:
        w, p = _build_where()
        w.append(f"EXTRACT(YEAR FROM vplf.date_order)::int = %s")
        p.append(current_year)
        sql = f"""
            SELECT EXTRACT(MONTH FROM vplf.date_order)::int as month,
                   COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
                   COUNT(DISTINCT vplf.order_id) as order_count,
                   COALESCE(SUM(vplf.qty), 0) as units_sold
            {vpl_from(need_store)}
            WHERE {" AND ".join(w)}
            GROUP BY month ORDER BY month
        """
        months_names = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
        monthly = query_pg(sql, p)
        monthly_str = " | ".join([f"{months_names[r['month']-1]}: S/{r['total_sales']:,.2f} ({r['units_sold']:.0f} uds)" for r in monthly])
        context_parts.append(f"Mensual {current_year}: {monthly_str}")
    except Exception as e:
        logger.error(f"Context monthly query error: {e}")

    # Sales by store current year
    try:
        w, p = _build_where()
        w.append(f"EXTRACT(YEAR FROM vplf.date_order)::int = %s")
        p.append(current_year)
        sql = f"""
            SELECT SPLIT_PART(sl.complete_name, '/', 2) as store_code,
                   COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
                   COUNT(DISTINCT vplf.order_id) as order_count,
                   COALESCE(SUM(vplf.qty), 0) as units_sold
            {vpl_from(need_store=True)}
            WHERE {" AND ".join(w)}
            GROUP BY store_code
            HAVING SPLIT_PART(sl.complete_name, '/', 2) IS NOT NULL AND SPLIT_PART(sl.complete_name, '/', 2) != ''
            ORDER BY total_sales DESC
        """
        by_store = query_pg(sql, p)
        stores_str = " | ".join([f"{r['store_code']}: S/{r['total_sales']:,.2f} ({r['order_count']} ord)" for r in by_store[:10]])
        context_parts.append(f"Tiendas {current_year}: {stores_str}")
    except Exception as e:
        logger.error(f"Context store query error: {e}")

    # Sales by marca current year
    try:
        w, p = _build_where()
        w.append(f"EXTRACT(YEAR FROM vplf.date_order)::int = %s")
        p.append(current_year)
        w.append("vplf.marca IS NOT NULL")
        sql = f"""
            SELECT vplf.marca,
                   COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
                   COALESCE(SUM(vplf.qty), 0) as units_sold
            {vpl_from(need_store)}
            WHERE {" AND ".join(w)}
            GROUP BY vplf.marca ORDER BY total_sales DESC
        """
        by_marca = query_pg(sql, p)
        marcas_str = " | ".join([f"{r['marca']}: S/{r['total_sales']:,.2f} ({r['units_sold']:.0f} uds)" for r in by_marca[:10]])
        context_parts.append(f"Marcas {current_year}: {marcas_str}")
    except Exception as e:
        logger.error(f"Context marca query error: {e}")

    return "\n".join(context_parts)

def _run_custom_query(question):
    """Run a specific date-based query if the user asks about specific dates."""
    import re
    date_patterns = re.findall(r'(\d{1,2})\s*(?:de\s+)?(?:del?\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*(?:de\s+|del?\s+)?(\d{4})', question.lower())
    month_map = {'enero':'01','febrero':'02','marzo':'03','abril':'04','mayo':'05','junio':'06',
                 'julio':'07','agosto':'08','septiembre':'09','octubre':'10','noviembre':'11','diciembre':'12'}

    if date_patterns:
        results = []
        for day, month_name, year in date_patterns:
            date_str = f"{year}-{month_map[month_name]}-{int(day):02d}"
            sql = f"""
                SELECT SPLIT_PART(sl.complete_name, '/', 2) as store_code,
                       COALESCE(SUM(vplf.price_subtotal), 0) as total_sales,
                       COUNT(DISTINCT vplf.order_id) as order_count,
                       COALESCE(SUM(vplf.qty), 0) as units_sold
                {vpl_from(need_store=True)}
                WHERE {VPL_BASE} AND vplf.date_order::date = %s
                    AND SPLIT_PART(sl.complete_name, '/', 2) IS NOT NULL
                    AND SPLIT_PART(sl.complete_name, '/', 2) != ''
                GROUP BY store_code ORDER BY total_sales DESC
            """
            rows = query_pg(sql, [date_str], use_cache=True)
            if rows:
                total = sum(r['total_sales'] for r in rows)
                detail = ", ".join([f"{r['store_code']}: S/{r['total_sales']:,.2f} ({r['order_count']} ord, {r['units_sold']:.0f} uds)" for r in rows])
                results.append(f"Fecha {date_str}: TOTAL S/{total:,.2f} | Detalle: {detail}")
            else:
                results.append(f"Fecha {date_str}: SIN VENTAS registradas")
        return "\n".join(results)
    return None


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    filters: Optional[dict] = None

class ChatResponse(BaseModel):
    response: str
    session_id: str

chat_sessions = {}

@api_router.post("/chat")
async def chat_endpoint(req: ChatRequest):
    session_id = req.session_id or str(uuid.uuid4())

    # Gather data context
    filters = req.filters or {}
    data_context = _gather_context(filters)

    # Check for specific date queries
    custom_data = _run_custom_query(req.message)
    if custom_data:
        data_context += f"\n\nDatos específicos consultados:\n{custom_data}"

    current_year = datetime.now().year
    system_prompt = SYSTEM_PROMPT_BASE.format(
        current_date=datetime.now().strftime('%d/%m/%Y'),
        current_year=current_year,
        prev_year=current_year - 1
    )
    full_system = f"{system_prompt}\n\n--- DATOS DE CONTEXTO ACTUAL ---\n{data_context}"

    # Check for custom API key from PostgreSQL
    custom_key = _pg_get_setting("openai_api_key")
    api_key = custom_key if custom_key else os.environ['EMERGENT_LLM_KEY']

    # Get or create chat session
    if session_id not in chat_sessions:
        chat = LlmChat(
            api_key=api_key,
            session_id=session_id,
            system_message=full_system
        ).with_model("openai", "gpt-4o-mini")
        chat_sessions[session_id] = chat
    else:
        chat = chat_sessions[session_id]
        chat.system_message = full_system

    user_msg = UserMessage(text=req.message)
    response_text = await chat.send_message(user_msg)

    # Save to PostgreSQL
    import json as json_mod
    filters_str = json_mod.dumps(filters) if filters else None
    _pg_save_chat_message(session_id, "user", req.message, filters_str)
    _pg_save_chat_message(session_id, "assistant", response_text)

    return ChatResponse(response=response_text, session_id=session_id)

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
