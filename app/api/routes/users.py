from fastapi import APIRouter, Depends, HTTPException, status
from typing import Any
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.user import User as UserSchema, UserUpdate
from app.api.deps import get_current_user
from app.db.database import get_db
from app.core.security import get_password_hash

router = APIRouter()

@router.get("/me", response_model=UserSchema)
def read_user_me(
    current_user: User = Depends(get_current_user),
) -> Any:
    """
    Get current user.
    """
    return current_user


@router.put("/me", response_model=UserSchema)
def update_user_me(
    payload: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Any:
    """Update the current authenticated user's profile and optional password."""
    update_data = payload.model_dump(exclude_unset=True)

    if "email" in update_data and update_data["email"] is not None:
        normalized_email = update_data["email"].strip().lower()
        existing_user = (
            db.query(User)
            .filter(User.email == normalized_email, User.id != current_user.id)
            .first()
        )
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email is already in use",
            )
        current_user.email = normalized_email

    if "first_name" in update_data and update_data["first_name"] is not None:
        first_name = update_data["first_name"].strip()
        if not first_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="First name cannot be empty",
            )
        current_user.first_name = first_name

    if "last_name" in update_data and update_data["last_name"] is not None:
        last_name = update_data["last_name"].strip()
        if not last_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Last name cannot be empty",
            )
        current_user.last_name = last_name

    password = update_data.get("password")
    if password:
        current_user.hashed_password = get_password_hash(password)

    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return current_user
