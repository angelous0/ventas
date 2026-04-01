# PRD - CRM Sales Reports Module (Ambission Industries)

## Problem Statement
Build a CRM reports module that connects to an external PostgreSQL database (Odoo 10 POS data) to generate comprehensive sales analytics dashboards. Data from `pos.order` filtered by `is_cancel=false`, `order_cancel=false`, `reserva=false` (ventas reales).

## Architecture
- **Backend**: FastAPI + psycopg2 connecting to external PostgreSQL (72.60.241.216:9090, db=datos, schema=odoo)
- **Frontend**: React + Tailwind CSS + shadcn/ui + recharts
- **Data Source**: PostgreSQL views (v_pos_line_full) + raw tables
- **Cache**: In-memory TTL cache (2 min) for query results
- **AI Chat**: GPT-4o-mini via emergentintegrations library
- **App Data**: PostgreSQL tables `app_settings` and `chat_messages` (same DB as Odoo data)

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
- User-configurable OpenAI API key (stored in PostgreSQL)

## What's Been Implemented

### Iteration 1-2 (2026-03-24)
- Full dashboard with KPIs, charts, 6 pages (Dashboard, Ventas, Productos, Tiendas, Clientes, Asistente IA)
- Multi-select filters, "Hasta la fecha" toggle, in-memory cache

### Iteration 3 (2026-03-25)
- Store temporal tracking with day/week/month granularity
- Cumulative sales chart in Sales Analysis

### Iteration 4 (2026-03-25)
- AI Chat Assistant (GPT-4o-mini) with real-time DB context
- Configurable OpenAI API Key via UI

### Iteration 5 (2026-03-25)
- **Migrated all app data from MongoDB to PostgreSQL**: settings and chat_messages tables
- API key and chat history now stored in user's own PostgreSQL database
- Tables auto-created on startup (`app_settings`, `chat_messages`)

## Prioritized Backlog
### P1
- [ ] PDF export
- [ ] Date range picker (calendar) for custom date filtering

### P2
- [ ] Redis cache for production
- [ ] Dashboard auto-refresh
- [ ] Individual product/SKU analysis
- [ ] Mobile responsive optimization
