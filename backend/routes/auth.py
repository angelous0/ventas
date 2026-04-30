"""Auth endpoints. Reusa produccion.prod_usuarios."""
from fastapi import APIRouter, HTTPException, Depends
from db import get_pool
from auth_utils import verify_password, create_access_token, get_current_user
from models import UserLogin
from helpers import row_to_dict

router = APIRouter(prefix="/api")


@router.post("/auth/login")
async def login(credentials: UserLogin):
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await conn.fetchrow(
            "SELECT * FROM produccion.prod_usuarios WHERE username = $1 AND activo = true",
            credentials.username
        )
        if not user or not verify_password(credentials.password, user['password_hash']):
            raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")

        token = create_access_token(data={"sub": user['id']})
        user_dict = row_to_dict(user)
        user_dict.pop('password_hash', None)
        return {"access_token": token, "token_type": "bearer", "user": user_dict}


@router.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    user_dict = row_to_dict(current_user)
    user_dict.pop('password_hash', None)
    return user_dict
