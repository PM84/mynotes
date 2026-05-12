from httpx import AsyncClient


async def test_healthz(client: AsyncClient):
    r = await client.get("/healthz")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "version" in data


async def test_login_bad_password(client: AsyncClient):
    r = await client.post(
        "/auth/login", json={"email": "admin@test.com", "password": "wrong"}
    )
    assert r.status_code == 401


async def test_login_ok(client: AsyncClient):
    r = await client.post(
        "/auth/login", json={"email": "admin@test.com", "password": "test123"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert body["refresh_token"]


async def test_me_requires_auth(client: AsyncClient):
    r = await client.get("/auth/me")
    assert r.status_code == 401


async def test_me_with_token(client: AsyncClient, auth_headers: dict):
    r = await client.get("/auth/me", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["email"] == "admin@test.com"
    assert r.json()["role"] == "admin"
