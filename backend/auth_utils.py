"""Shared authentication utilities. Reusa tabla produccion.prod_usuarios."""
import os
from datetime import datetime, timezone, timedelta
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import bcrypt as _bcrypt
from jose import JWTError, jwt
from db import get_pool

SECRET_KEY = os.environ.get('JWT_SECRET_KEY')
if not SECRET_KEY:
    raise RuntimeError("FATAL: Variable JWT_SECRET_KEY no configurada.")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 8760

security = HTTPBearer(auto_error=False)


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))


def get_password_hash(password: str) -> str:
    return _bcrypt.hashpw(password.encode('utf-8'), _bcrypt.gensalt()).decode('utf-8')


def create_access_token(data: dict, expires_delta: timedelta = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if not credentials:
        raise HTTPException(status_code=401, detail="No autenticado")
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Token inválido")
    except JWTError:
        raise HTTPException(status_code=401, detail="Token inválido o expirado")
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await conn.fetchrow(
            "SELECT * FROM produccion.prod_usuarios WHERE id = $1 AND activo = true",
            user_id
        )
        if not user:
            raise HTTPException(status_code=401, detail="Usuario no encontrado o inactivo")
        return dict(user)


async def get_current_user_optional(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if not credentials:
        return None
    try:
        return await get_current_user(credentials)
    except Exception:
        return None


# ============================================================
# Control de acceso por rol
# ============================================================
# Cada rol tiene asignado un conjunto de "áreas" permitidas. Una área
# corresponde a un prefijo de path bajo /api/. El endpoint /api/auth/* y
# /api/health son siempre accesibles (autenticación y health-check).
#
# Para agregar un rol nuevo: añadir entrada al dict ROL_AREAS.
# Para agregar un endpoint a un área: ver mapeo PATH_AREAS más abajo.
# ============================================================

# Roles → áreas permitidas. None = acceso total (admin).
ROL_AREAS = {
    'admin':              None,                    # acceso a todo
    'usuario':            None,                    # default — acceso a todo (legacy)
    'inventario_viewer':  {'inventario', 'reposicion', 'stock', 'produccion',
                           'config_stock', 'catalogos',
                           # reservas: ver pendientes
                           'reservas',
                           # sync: ver estado "Datos hace X" + botón "Actualizar ahora"
                           'sync'},
    'ventas_viewer':      {'ventas', 'dashboard', 'productos', 'clientes',
                           'tiendas', 'departamentos', 'tendencias',
                           'pareto', 'clasificacion', 'reservas', 'catalogos',
                           'sync'},
}

# Mapeo path-prefix → área. El prefijo se evalúa contra el path después
# de /api/. Match más largo gana.
PATH_AREAS = [
    # Inventario / stock
    ('inventario',       'inventario'),
    ('stock',            'inventario'),
    ('produccion',       'inventario'),
    ('config/stock-max', 'config_stock'),
    # Ventas
    ('dashboard',        'dashboard'),
    ('productos-odoo',   'productos'),
    ('productos',        'productos'),
    ('clientes',         'clientes'),
    ('tiendas',          'tiendas'),
    ('departamentos',    'departamentos'),
    ('tendencias',       'tendencias'),
    ('clasificacion',    'clasificacion'),
    ('reservas',         'reservas'),
    ('alertas',          'ventas'),
    ('proyeccion',       'ventas'),
    ('export',           'ventas'),
    # sync: estado y trigger de actualización. Compartido por inventario y ventas.
    ('sync',             'sync'),
    # Catálogos: lectura compartida
    ('catalogos',        'catalogos'),
]


def _path_to_area(path: str) -> str:
    """Devuelve el área lógica de un path /api/<algo>. Ej: /api/inventario/snapshot → 'inventario'."""
    # Quitar /api/ prefix
    p = path.lstrip('/')
    if p.startswith('api/'):
        p = p[4:]
    # Match el prefijo más específico (más largo) primero
    p = p.lower()
    matches = [(prefix, area) for prefix, area in PATH_AREAS if p.startswith(prefix.lower())]
    if not matches:
        return 'otros'
    # Ordenar por longitud descendente del prefijo
    matches.sort(key=lambda x: -len(x[0]))
    return matches[0][1]


def user_can_access_path(user: dict, path: str) -> bool:
    """¿Este usuario tiene permiso para acceder a este path?

    Reglas:
    - /api/auth/* y /api/health siempre OK
    - Si el rol no está en ROL_AREAS → asumir acceso total (compat con usuarios viejos)
    - Si ROL_AREAS[rol] is None → acceso total
    - Si el área del path está en el set permitido → OK; sino → 403
    """
    p = path.lstrip('/')
    if p.startswith('api/'):
        p = p[4:]
    p = p.lower()
    # Endpoints siempre permitidos para autenticarse y healthcheck
    if p.startswith('auth/') or p == 'auth' or p == 'health' or p.startswith('health'):
        return True
    rol = (user or {}).get('rol') or 'usuario'
    areas = ROL_AREAS.get(rol)
    if areas is None:
        return True  # Acceso total
    area = _path_to_area(path)
    return area in areas
