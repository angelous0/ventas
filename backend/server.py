from fastapi import FastAPI, APIRouter, Query, Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import time
import hashlib
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone
from decimal import Decimal
from io import BytesIO
import psycopg2
from psycopg2 import pool as pg_pool_module
from contextlib import contextmanager

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
