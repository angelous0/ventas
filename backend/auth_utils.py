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
