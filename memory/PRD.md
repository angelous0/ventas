# PRD - CRM Sales Reports Module (Ambission Industries)

## Problem Statement
Build a CRM reports module that connects to an external PostgreSQL database (Odoo 10 POS data) to generate comprehensive sales analytics dashboards. Data from `pos.order` filtered by `is_cancel=false`, `order_cancel=false`, `reserva=false` (ventas reales).

## Architecture
- **Backend**: FastAPI + psycopg2 connecting to external PostgreSQL (72.60.241.216:9090, db=datos, schema=odoo)
- **Frontend**: React + Tailwind CSS + shadcn/ui + recharts
- **Data Source**: PostgreSQL views (v_pos_line_full) + raw tables
- **Cache**: In-memory TTL cache (2 min) for query results

## User Personas
- **Primary**: Business owner/manager at Ambission Industries S.A.C. (Peruvian clothing retail)

## Core Requirements
- Year-over-year sales comparisons with "Hasta la fecha" option
- Multi-select filters by marca, tipo, tienda
- KPI indicators: total sales, orders, avg ticket, units sold
- Export to Excel
- Light/dark mode toggle
- Temporal store tracking by day/week/month (amount + quantity)

## What's Been Implemented

### Iteration 1 (2026-03-24)
- Full dashboard with KPIs, charts, 5 pages
- Backend with 13+ API endpoints
- Excel export, dark mode

### Iteration 2 (2026-03-24)
- Multi-select filters for marca, tipo, tienda
- "Hasta la fecha" toggle for fair YoY comparison
- In-memory cache (2-minute TTL)
- Fixed year chart lines display
- Connection pool optimization

### Iteration 3 (2026-03-25)
- **Store temporal tracking**: New `/api/store-timeline` endpoint with day/week/month granularity
- **Stores page redesign**: Year selector, store multi-select badges, granularity controls (Dia/Semana/Mes), metric toggle (Dinero/Cantidad)
- **Timeline line chart**: Multi-store comparison over time with color-coded lines
- **Timeline data table**: Period-based detail with Ventas and Unidades per store
- **Cumulative sales chart** added to Sales Analysis page

## Data Verification
- **106,037 valid sales** (real) out of 140,380 total orders
- Filtering out: 7,731 cancelled + 7,729 order_cancelled + 30,785 reservas
- Data spans 2018-2026

## Known Limitation
- `x_tipo_resumen` field does NOT exist in the synced PostgreSQL mirror database. Only `tipo` from product_template is available (using `tipo_resumen` field).

## Prioritized Backlog
### P1
- [ ] PDF export
- [ ] Date range picker (calendar) for custom date filtering

### P2
- [ ] Redis cache for production
- [ ] Dashboard auto-refresh
- [ ] Individual product/SKU analysis
- [ ] Mobile responsive optimization
