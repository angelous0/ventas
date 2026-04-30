"""DDL de startup: tablas de configuración de Ventas.

Contiene:
- prod_alertas_ventas_config — umbrales de alertas
- config_stock_max          — tope físico por (tienda × tipo) para /reposicion
"""
from db import get_pool

ALERTAS_DEFAULTS = [
    ("marca_cae", -15, None),
    ("marca_crece", 30, None),
    ("entalle_sube", 40, None),
    ("cliente_inactivo", None, 60),
    ("tienda_cae", -10, None),
    ("producto_estrella", 50, None),
]

# ─────────────────────────────────────────────────────────────────
# Tope físico por SKU según (tienda × tipo)
# ─────────────────────────────────────────────────────────────────
# Base: tiendas grandes con factor 1.0. Otros factores aplican multiplicador.
# Reglas:
#   - TALLER y AP son almacenes → tope efectivamente "infinito" (1000) para no
#     restringir el origen interno.
#   - Tiendas comerciales: factor por tamaño del local físico.
TOPE_BASE_POR_TIPO = {
    'Pantalon':      100,
    'Polo':          150,
    'Casaca':         40,
    'Short':          80,
    'Camisa':         60,
    'Bomber Jacket':  30,
}

# Factor por tienda (sobre TOPE_BASE_POR_TIPO). 1.0 = tope base.
FACTOR_POR_TIENDA = {
    # Almacenes (no son tiendas comerciales). Tope alto para no estorbar.
    'TALLER': None,   # None = usar tope alto fijo
    'AP':     None,
    # Tiendas grandes
    'GR238':  1.0,
    'GM218':  1.0,
    # Tiendas medianas
    'GM209':  0.7,
    'GM207':  0.7,
    'BOOSH':  0.7,
    # Tiendas pequeñas / outlet
    'GR55':   0.4,
    'AZUL':   0.4,
    'ZAP':    0.4,
    'REMATE': 0.4,
}

ALMACEN_TOPE = 1000  # Para TALLER, AP — no cap operativo


def _tope(tienda: str, tipo: str) -> int:
    """Tope sugerido para una (tienda, tipo). Devuelve int > 0."""
    factor = FACTOR_POR_TIENDA.get(tienda, 0.7)  # default tienda mediana
    if factor is None:  # Almacén
        return ALMACEN_TOPE
    base = TOPE_BASE_POR_TIPO.get(tipo, 50)  # default 50 si tipo desconocido
    return max(int(round(base * factor)), 1)


async def ensure_startup_ddl():
    pool = await get_pool()
    async with pool.acquire() as conn:
        # ── Alertas (existente) ──
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS produccion.prod_alertas_ventas_config (
                id VARCHAR PRIMARY KEY,
                empresa_id INTEGER NOT NULL DEFAULT 7,
                tipo VARCHAR NOT NULL,
                umbral_pct NUMERIC,
                dias_referencia INTEGER,
                activa BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        """)
        count = await conn.fetchval("SELECT COUNT(*) FROM produccion.prod_alertas_ventas_config")
        if count == 0:
            for tipo, umbral, dias in ALERTAS_DEFAULTS:
                await conn.execute(
                    """INSERT INTO produccion.prod_alertas_ventas_config
                       (id, tipo, umbral_pct, dias_referencia) VALUES ($1, $2, $3, $4)""",
                    tipo, tipo, umbral, dias
                )

        # ── Tope físico por (tienda × tipo) ──
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS produccion.config_stock_max (
                tienda_codigo TEXT NOT NULL,
                tipo_nombre   TEXT NOT NULL,
                stock_max_por_sku INT NOT NULL CHECK (stock_max_por_sku > 0),
                activo BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (tienda_codigo, tipo_nombre)
            );
        """)
        # Seed: cruz tiendas × (tipos del catálogo + tipos detectados en pt.tipo
        # de templates con stock activo). Esto cubre tipos sueltos como
        # 'Polera', 'Biviri', 'Camisaco' que aparecen en producción aunque
        # no estén en prod_tipos.
        # Solo seedeamos COMBINACIONES FALTANTES (ON CONFLICT DO NOTHING),
        # así no pisamos valores manualmente editados.
        tiendas = list(FACTOR_POR_TIENDA.keys())
        tipos_catalogo = await conn.fetch(
            "SELECT nombre FROM produccion.prod_tipos ORDER BY nombre"
        )
        tipos_detectados = await conn.fetch("""
            SELECT DISTINCT TRIM(pt.tipo) AS nombre
            FROM odoo.product_template pt
            WHERE pt.tipo IS NOT NULL AND TRIM(pt.tipo) <> ''
              AND pt.active = true
            ORDER BY 1
        """)
        tipos_set = set()
        for r in tipos_catalogo:
            tipos_set.add(r["nombre"])
        for r in tipos_detectados:
            # Tomar la primera palabra para normalizar "Pantalon Denim" → "Pantalon"
            nombre = r["nombre"].split()[0] if r["nombre"] else ""
            if nombre:
                tipos_set.add(nombre)
        # También añadir las palabras completas detectadas (por si el match
        # exacto requiere "Bomber Jacket" y no solo "Bomber")
        for r in tipos_detectados:
            nombre = r["nombre"].strip()
            if nombre:
                tipos_set.add(nombre)
        tipos = sorted(tipos_set)
        for tienda in tiendas:
            for tipo in tipos:
                await conn.execute(
                    """INSERT INTO produccion.config_stock_max
                       (tienda_codigo, tipo_nombre, stock_max_por_sku)
                       VALUES ($1, $2, $3)
                       ON CONFLICT (tienda_codigo, tipo_nombre) DO NOTHING""",
                    tienda, tipo, _tope(tienda, tipo)
                )
