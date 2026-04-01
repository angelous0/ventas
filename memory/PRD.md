# PRD - CRM Sales Reports Module (Ambission Industries)

## Problem Statement
Build a CRM reports module that connects to an external PostgreSQL database (Odoo 10 POS data) to generate comprehensive sales analytics dashboards with AI-powered chat assistant.

## Architecture
- **Backend**: FastAPI + psycopg2 connecting to external PostgreSQL (72.60.241.216:9090, db=datos, schema=odoo)
- **Frontend**: React + Tailwind CSS + shadcn/ui + recharts
- **AI Chat**: GPT-4o-mini via emergentintegrations — SQL-powered with inline chart generation
- **App Data**: PostgreSQL tables `app_settings` and `chat_messages`

## AI Chat Architecture (SQL-powered + Charts)
1. User asks question → LLM generates SELECT SQL
2. Backend executes SQL read-only against PostgreSQL
3. Auto-detects if data is chartable (line for time-series, bar for rankings)
4. LLM formats human-readable analytical response with Markdown
5. Frontend renders: formatted text + table + inline Recharts chart

## What's Been Implemented
- Full dashboard with KPIs, charts, 6 pages (Dashboard, Ventas, Productos, Tiendas, Clientes, Asistente IA)
- Multi-select filters, "Hasta la fecha" toggle, in-memory cache
- Store temporal tracking with day/week/month granularity
- AI Chat with SQL access to full DB schema (all fields: producto, tipo, tela, entalle, talla, color, cliente, tienda)
- Markdown rendering (tables, bold, lists, headers) via react-markdown + remark-gfm
- Inline chart generation (line charts for trends, bar charts for rankings)
- Configurable OpenAI API key stored in PostgreSQL
- Spanish language understanding with typo correction
- Valid values catalog in prompt (marcas, entalles, telas, tipos, tiendas)

## Prioritized Backlog
### P1
- [ ] PDF export
- [ ] Date range picker (calendar) for custom date filtering

### P2
- [ ] Redis cache for production
- [ ] Dashboard auto-refresh
- [ ] Individual product/SKU analysis
- [ ] Mobile responsive optimization
