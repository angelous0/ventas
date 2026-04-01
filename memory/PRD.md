# PRD - CRM Sales Reports Module (Ambission Industries)

## Problem Statement
Build a CRM reports module that connects to an external PostgreSQL database (Odoo 10 POS data) to generate comprehensive sales analytics dashboards. Data from `pos.order` filtered by `is_cancel=false`, `order_cancel=false`, `reserva=false` (ventas reales).

## Architecture
- **Backend**: FastAPI + psycopg2 connecting to external PostgreSQL (72.60.241.216:9090, db=datos, schema=odoo)
- **Frontend**: React + Tailwind CSS + shadcn/ui + recharts
- **Data Source**: PostgreSQL views (v_pos_line_full) + raw tables
- **Cache**: In-memory TTL cache (2 min) for query results
- **AI Chat**: GPT-4o-mini via emergentintegrations — SQL-powered (text-to-SQL approach)
- **App Data**: PostgreSQL tables `app_settings` and `chat_messages` (same DB as Odoo data)

## AI Chat Architecture (SQL-powered)
1. User asks a question in natural language
2. Step 1 (LLM call): Given full DB schema → LLM generates a SELECT SQL query
3. Step 2 (execution): Backend runs the SQL read-only against PostgreSQL
4. Step 3 (LLM call): Given query results → LLM formats a human-readable analytical response
- The AI can now access ALL fields: producto, tipo, tela, entalle, talla, color, cliente, tienda, vendedor, fecha, etc.
- Filters from the UI are passed as hints to the SQL generation step

## What's Been Implemented

### Iteration 1-2 (2026-03-24)
- Full dashboard with KPIs, charts, 6 pages
- Multi-select filters, "Hasta la fecha" toggle, in-memory cache

### Iteration 3 (2026-03-25)
- Store temporal tracking with day/week/month granularity

### Iteration 4 (2026-03-25)
- AI Chat Assistant with configurable OpenAI API key

### Iteration 5 (2026-03-25)
- Migrated all app data from MongoDB to PostgreSQL

### Iteration 6 (2026-03-25)
- **SQL-powered AI chat**: LLM generates SQL queries against full DB schema
- Access to ALL data fields: producto, tipo_resumen, tela, entalle, talla, color, cliente, tienda, día, semana, vendedor, método de pago
- Read-only safety validation on generated SQL
- 15s query timeout for safety
- Results truncated at 8KB to manage token costs

## Prioritized Backlog
### P1
- [ ] PDF export
- [ ] Date range picker (calendar) for custom date filtering

### P2
- [ ] Redis cache for production
- [ ] Dashboard auto-refresh
- [ ] Individual product/SKU analysis
- [ ] Mobile responsive optimization
