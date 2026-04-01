# PRD - CRM Sales Reports Module (Ambission Industries)

## Problem Statement
Build a CRM reports module that connects to an external PostgreSQL database (Odoo 10 POS data) to generate comprehensive sales analytics dashboards. Data from `pos.order` filtered by `is_cancel=false`, `order_cancel=false`, `reserva=false` (ventas reales).

## Architecture
- **Backend**: FastAPI + psycopg2 connecting to external PostgreSQL (72.60.241.216:9090, db=datos, schema=odoo)
- **Frontend**: React + Tailwind CSS + shadcn/ui + recharts
- **Data Source**: PostgreSQL views (v_pos_line_full) + raw tables
- **Cache**: In-memory TTL cache (2 min) for query results
- **AI Chat**: GPT-4o-mini via emergentintegrations library + MongoDB for message persistence

## User Personas
- **Primary**: Business owner/manager at Ambission Industries S.A.C. (Peruvian clothing retail)

## Core Requirements
- Year-over-year sales comparisons with "Hasta la fecha" option
- Multi-select filters by marca, tipo, tienda
- KPI indicators: total sales, orders, avg ticket, units sold
- Export to Excel
- Light/dark mode toggle
- Temporal store tracking by day/week/month (amount + quantity)
- AI chat assistant for natural language sales queries

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
- Store temporal tracking: `/api/store-timeline` with day/week/month granularity
- Stores page: year selector, store badges, granularity/metric controls, timeline chart & table
- Cumulative sales chart in Sales Analysis

### Iteration 4 (2026-03-25)
- **AI Chat Assistant**: Dedicated `/asistente` page with GPT-4o-mini integration
- Natural language queries on sales data with real-time DB context
- Specific date query detection (e.g., "17 de abril del 2025")
- Filter-aware context (respects active marca/tipo/tienda filters)
- Chat history persistence in MongoDB
- Suggestion buttons for common queries
- Session management with "Nueva conversacion" button

## Data Verification
- **106,037 valid sales** (real) out of 140,380 total orders
- Data spans 2018-2026

## Known Limitation
- `x_tipo_resumen` not in synced PostgreSQL; using `tipo_resumen` from product_template

## Prioritized Backlog
### P1
- [ ] PDF export
- [ ] Date range picker (calendar) for custom date filtering

### P2
- [ ] Redis cache for production
- [ ] Dashboard auto-refresh
- [ ] Individual product/SKU analysis
- [ ] Mobile responsive optimization
- [ ] Chat session cleanup for memory management
