import io

from httpx import AsyncClient

# minimaler 1×1-PNG für MIME-Erkennung via libmagic
PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n"
    + b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    + b"\x00\x00\x00\rIDATx\x9cc\xfc\xff\xff?\x03\x00\x05\xfe\x02\xfe\xa3\x35\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82"
)


async def test_upload_image_creates_asset(client: AsyncClient, auth_headers: dict):
    files = {"file": ("pixel.png", io.BytesIO(PNG_1X1), "image/png")}
    r = await client.post("/assets", headers=auth_headers, files=files)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["mime"] == "image/png"
    assert out["size"] == len(PNG_1X1)
    assert len(out["sha256"]) == 64


async def test_upload_dedup(client: AsyncClient, auth_headers: dict):
    files = {"file": ("a.png", io.BytesIO(PNG_1X1), "image/png")}
    r1 = await client.post("/assets", headers=auth_headers, files=files)
    files = {"file": ("b.png", io.BytesIO(PNG_1X1), "image/png")}
    r2 = await client.post("/assets", headers=auth_headers, files=files)
    assert r1.json()["sha256"] == r2.json()["sha256"]
    assert r1.json()["id"] == r2.json()["id"]


async def test_reject_disallowed_mime(client: AsyncClient, auth_headers: dict):
    # ZIP-Header → nicht in ALLOWED_MIMES
    data = b"PK\x03\x04" + b"\x00" * 100
    files = {"file": ("evil.zip", io.BytesIO(data), "application/zip")}
    r = await client.post("/assets", headers=auth_headers, files=files)
    assert r.status_code == 415


async def test_download_after_upload(client: AsyncClient, auth_headers: dict):
    files = {"file": ("p.png", io.BytesIO(PNG_1X1), "image/png")}
    r = await client.post("/assets", headers=auth_headers, files=files)
    aid = r.json()["id"]
    r = await client.get(f"/assets/{aid}", headers=auth_headers)
    assert r.status_code == 200
    assert r.content == PNG_1X1
