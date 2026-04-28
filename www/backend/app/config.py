from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "MyNotes"
    debug: bool = False

    db_url: str = "mysql+asyncmy://app:app@db:3306/mynotes"

    jwt_secret: str = "change-me"
    jwt_alg: str = "HS256"
    jwt_access_minutes: int = 15
    jwt_refresh_days: int = 7

    asset_dir: str = "/app/data/assets"
    upload_max_mb: int = 64

    bootstrap_admin_email: str = "admin@example.com"
    bootstrap_admin_password: str = "change-me"

    cors_origins: str = "https://mynotes.localhost"


@lru_cache
def get_settings() -> Settings:
    return Settings()
