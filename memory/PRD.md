# PRD - CRM Sales Reports Module (Ambission Industries)

## Problem Statement
Build a CRM reports module that connects to an external PostgreSQL database (Odoo 10 POS data) to generate comprehensive sales analytics dashboards. Data from `pos.order` filtered by `is_cancel=false`, `reserva=false`, `order_cancel=false`.

## Architecture
- **Backend**: FastAPI + psycopg2 connecting to external PostgreSQL (72.60.241.216:9090, db=datos, schema=odoo)
- **Frontend**: React + Tailwind CSS + shadcn/ui + recharts
- **Data Source**: PostgreSQL views (v_pos_line_full, v_pos_order_enriched) + raw tables
- **No local DB storage**: All queries run directly against external PostgreSQL

## User Personas
- **Primary**: Business owner/manager at Ambission Industries S.A.C. (Peruvian clothing retail)
- **Use Case**: Analyze POS sales data to make business decisions, compare year-over-year, track brand/store/client performance

## Core Requirements
- Year-over-year sales comparisons
- Filters by marca (brand), tipo (product type), tienda (store)
- KPI indicators: total sales, orders, avg ticket, units sold
- Export to Excel
- Light/dark mode toggle

## What's Been Implemented (2026-03-24)
- **Dashboard**: KPIs with YoY comparison (same period), monthly trend, sales by marca, top stores, top clients
- **Ventas (Sales Analysis)**: Year selector badges, monthly comparison line chart, year summary table, orders by month grouped bar
- **Productos**: Tabs for Marcas/Tipos/Tendencia, bar charts, detailed tables with % total
- **Tiendas**: Store performance horizontal bar chart, ranking table
- **Clientes**: Top 20 clients table, click-to-see client detail with yearly history bar chart
- **Global Filters**: Marca, tipo, store dropdowns in header, clear filters button
- **Theme**: Light/dark mode toggle
- **Export**: Excel download for all report types
- **Backend**: 13 API endpoints (/api/filters, /api/kpis, /api/sales-trend, /api/sales-by-year, /api/year-monthly, /api/sales-by-marca, /api/sales-by-tipo, /api/marca-trend, /api/sales-by-store, /api/top-clients, /api/client-years, /api/export/excel)

## Prioritized Backlog
### P0 (Done)
- [x] PostgreSQL connection and data extraction
- [x] Dashboard with KPIs and charts
- [x] Year-over-year comparisons
- [x] Filters by marca, tipo, store
- [x] 5 pages: Dashboard, Ventas, Productos, Tiendas, Clientes
- [x] Excel export
- [x] Light/dark mode

### P1
- [ ] PDF export
- [ ] Date range picker (calendar) for custom date filtering
- [ ] Store year-over-year comparison
- [ ] Client year-over-year comparison on Clientes page
- [ ] Combination analysis: marca x tipo cross-tabulation

### P2
- [ ] Data caching (Redis or in-memory) for frequently accessed queries
- [ ] Dashboard auto-refresh interval
- [ ] Top products (individual SKU) analysis
- [ ] Mobile responsive layout optimization
- [ ] Print-friendly report views
