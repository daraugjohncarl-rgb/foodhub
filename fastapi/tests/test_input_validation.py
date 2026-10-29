"""
Input validation (2026-10-29): malformed drawer amounts, movement types, image uploads and inventory files are
refused with 4xx before anything is written, instead of crashing with a 500 (or, for cash-out, committing first).
Runs on SQLite: validation and write-ordering only; PostgreSQL locking is covered in test_postgres_concurrency.py.
"""
import pytest

import app.models as models
from test_drawer_security import staff, start, snapshot  # noqa: F401  (staff is a fixture)

BAD_AMOUNTS = ["NaN", "Infinity", "-Infinity", -1, "1.005", "123456789.01", "abc", True]


# ----------------------------------------------------------------------------- POST /shifts/cashout
@pytest.mark.parametrize("amount", BAD_AMOUNTS)
def test_cashout_rejects_bad_amounts_without_writing(client, staff, db, amount):
    sid = start(client, staff, "cash1")
    before = snapshot(db)
    r = client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": sid, "amount": amount})
    assert r.status_code == 422, r.text
    assert snapshot(db) == before
    assert db.get(models.Shift, sid).status == "open"


@pytest.mark.parametrize("body", [{"reason": "x" * 256}, {"reason": {"a": 1}}, {"shift_id": [1]}])
def test_cashout_rejects_bad_reason_and_shift_id_without_writing(client, staff, db, body):
    sid = start(client, staff, "cash1")
    before = snapshot(db)
    r = client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": sid, **body})
    assert r.status_code in (400, 422), r.text      # shift_id keeps the route's 400; schema fields are 422
    assert snapshot(db) == before


def test_cashout_valid_payloads_still_work(client, staff, db):
    sid = start(client, staff, "cash1", cash="300")
    r = client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": sid})   # amount omitted
    assert r.status_code == 200 and r.json()["amount_cashed_out"] == 300.0
    db.expire_all()
    assert db.get(models.Shift, sid).status == "closed"
    new_sid = r.json()["new_shift_id"]
    assert db.get(models.Shift, new_sid).status == "open"
    r = client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": new_sid, "amount": "150.50", "reason": None})
    assert r.status_code == 200 and r.json()["amount_cashed_out"] == 150.5


# ----------------------------------------------------------------------------- POST /shifts/cash-movement
def test_cash_movement_rejects_unknown_type_and_normalizes_case(client, staff, db):
    sid = start(client, staff, "boss")
    before = snapshot(db)
    r = client.post("/api/v1/shifts/cash-movement", headers=staff["boss"], json={"shift_id": sid, "type": "BOGUS", "amount": "5"})
    assert r.status_code == 422 and snapshot(db) == before
    r = client.post("/api/v1/shifts/cash-movement", headers=staff["boss"], json={"shift_id": sid, "type": " paid_in ", "amount": "5"})
    assert r.status_code == 200 and r.json()["type"] == "PAID_IN"
    db.expire_all()
    assert [m.type for m in db.query(models.ShiftCashMovement).filter_by(shift_id=sid)] == ["PAID_IN"]


@pytest.mark.parametrize("amount", ["NaN", "Infinity", "1.001", "123456789.01", 0])
def test_cash_movement_rejects_bad_amounts(client, staff, db, amount):
    sid = start(client, staff, "boss")
    before = snapshot(db)
    r = client.post("/api/v1/shifts/cash-movement", headers=staff["boss"], json={"shift_id": sid, "type": "PAID_OUT", "amount": amount})
    assert r.status_code == 422 and snapshot(db) == before


# ----------------------------------------------------------------------------- PUT /shifts/{id}/drawer-cash
@pytest.mark.parametrize("amount", ["NaN", "Infinity", "1.005", -5, "123456789.01", None])
def test_drawer_cash_rejects_bad_amounts_without_writing(client, staff, db, amount):
    sid = start(client, staff, "cash1")
    before = snapshot(db)
    r = client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["boss"], json={"amount": amount})
    assert r.status_code == 422, r.text
    assert snapshot(db) == before


def test_drawer_cash_closed_shift_is_not_modified(client, staff, db):
    sid = start(client, staff, "cash1")
    assert client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": sid}).status_code == 200
    before = snapshot(db)
    r = client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["boss"], json={"amount": "10"})
    assert r.status_code == 400 and snapshot(db) == before


def test_drawer_cash_long_reason_fits_the_column(client, staff, db):
    sid = start(client, staff, "cash1", cash="100")
    r = client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["boss"], json={"amount": "40", "reason": "r" * 255})
    assert r.status_code == 200 and r.json()["adjustment"] == -60.0
    db.expire_all()
    (m,) = db.query(models.ShiftCashMovement).filter_by(shift_id=sid).all()
    assert len(m.reason) <= 255 and m.reason.endswith("(Adjusted from ₱100.00 to ₱40.00)")
    assert client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["boss"], json={"amount": "40", "reason": "r" * 256}).status_code == 422


def test_drawer_cash_role_and_tenant_rules_unchanged(client, staff, db):
    sid = start(client, staff, "cash1")
    before = snapshot(db)
    assert client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["cash1"], json={"amount": "1"}).status_code == 403
    assert client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["boss_b"], json={"amount": "1"}).status_code == 404
    assert snapshot(db) == before


# ----------------------------------------------------------------------------- POST /products/upload-image
import os

import app.routers.products as products_router

FASTAPI_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(FASTAPI_DIR, "static", "images", "products")
ROOT_IMG_DIR = os.path.join(os.path.dirname(FASTAPI_DIR), "static", "images", "products")
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
GIF = b"GIF89a" + b"\x00" * 32
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 32


def listing(path):
    return sorted(os.listdir(path)) if os.path.isdir(path) else []


def upload(client, headers, name, data):
    return client.post("/api/v1/products/upload-image", headers=headers, files={"file": (name, data, "application/octet-stream")})


@pytest.mark.parametrize("name,data", [("a.png", PNG), ("a.jpg", JPEG), ("a.jpeg", JPEG), ("a.gif", GIF), ("a.webp", WEBP)])
def test_upload_accepts_real_images_and_writes_only_under_fastapi_static(client, staff, name, data):
    root_before = listing(ROOT_IMG_DIR)
    r = upload(client, staff["boss"], name, data)
    assert r.status_code == 200, r.text
    url = r.json()["image_url"]
    assert url.startswith("/static/images/products/prod_") and url.endswith(os.path.splitext(name)[1])
    saved = os.path.join(IMG_DIR, url.rsplit("/", 1)[1])
    try:
        assert open(saved, "rb").read() == data
        assert listing(ROOT_IMG_DIR) == root_before         # nothing written to the stale root-level static/
    finally:
        os.remove(saved)


@pytest.mark.parametrize("name,data", [("a.png", b"<html>not an image</html>"), ("a.png", JPEG), ("a.jpg", PNG), ("a.gif", b""), ("a.svg", PNG)])
def test_upload_rejects_fake_or_mismatched_images(client, staff, name, data):
    before = listing(IMG_DIR)
    assert upload(client, staff["boss"], name, data).status_code == 400
    assert listing(IMG_DIR) == before


def test_upload_rejects_oversized_image(client, staff):
    before = listing(IMG_DIR)
    assert upload(client, staff["boss"], "big.png", PNG + b"\x00" * (5 * 1024 * 1024)).status_code == 413
    assert listing(IMG_DIR) == before


def test_upload_write_failure_is_an_error_and_leaves_no_partial_file(client, staff, monkeypatch):
    real_open = open

    class FailingFile:
        def __init__(self, path, mode):
            self.f = real_open(path, mode)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.f.close()

        def write(self, data):
            self.f.write(data[:8])
            self.f.flush()
            raise OSError("disk full")

    monkeypatch.setattr(products_router, "open", FailingFile, raising=False)
    before = listing(IMG_DIR)
    r = upload(client, staff["boss"], "a.png", PNG)
    assert r.status_code == 500 and "image_url" not in r.text
    assert listing(IMG_DIR) == before


def test_upload_is_still_manager_or_admin_only(client, staff):
    assert upload(client, staff["cash1"], "a.png", PNG).status_code == 403


# ----------------------------------------------------------------------------- inventory masterlist uploads
import io
import zipfile

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def docx(document_xml=None, extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        if document_xml is not None:
            z.writestr("word/document.xml", document_xml)
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


SMALL_DOCX = docx(f'<w:document xmlns:w="{W}"><w:body>'
                  f'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Kitchen</w:t></w:r></w:p>'
                  f'<w:p><w:r><w:t>Chicken Breast</w:t></w:r></w:p></w:body></w:document>')


def send(client, headers, endpoint, name, data):
    return client.post(f"/api/v1/inventory/{endpoint}", headers=headers, files={"file": (name, data, "application/octet-stream")})


def test_masterlist_valid_files_still_parse_and_import(client, staff, db):
    r = send(client, staff["boss"], "parse-file", "list.csv", b"name,department,unit\nRice,Kitchen,kg\n")
    assert r.status_code == 200 and r.json()["total_items"] == 1 and r.json()["departments"]["Kitchen"][0]["name"] == "Rice"
    r = send(client, staff["boss"], "parse-file", "list.docx", SMALL_DOCX)
    assert r.status_code == 200 and r.json()["departments"] == {"Kitchen": [{"name": "Chicken Breast", "unit": "kg", "min_stock": 5.0}]}
    before = db.query(models.InventoryItem).count()
    r = send(client, staff["boss"], "import-file", "list.txt", b"Rice,Kitchen,kg\n")
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(models.InventoryItem).count() == before + 1


@pytest.mark.parametrize("endpoint", ["parse-file", "import-file"])
def test_masterlist_upload_limits(client, staff, db, endpoint):
    before = db.query(models.InventoryItem).count()
    assert send(client, staff["boss"], endpoint, "big.csv", b"x" * (5 * 1024 * 1024 + 1)).status_code == 413
    assert send(client, staff["boss"], endpoint, "tool.exe", b"MZ...").status_code == 400
    assert send(client, staff["boss"], endpoint, "empty.csv", b"").status_code == 400
    assert send(client, staff["boss"], endpoint, "broken.docx", b"not a zip").status_code == 400
    assert send(client, staff["boss"], endpoint, "nodoc.docx", docx(extra={"other.xml": "<x/>"})).status_code == 400
    bomb = docx(f'<w:document xmlns:w="{W}"><w:body>' + " " * (10 * 1024 * 1024) + "</w:body></w:document>")
    assert len(bomb) < 100_000                                 # small on the wire, >10 MB once unpacked
    r = send(client, staff["boss"], endpoint, "bomb.docx", bomb)
    assert r.status_code == 400 and "too large" in r.text
    db.expire_all()
    assert db.query(models.InventoryItem).count() == before


def test_masterlist_upload_without_a_filename_is_refused(client, staff):
    # A part without a filename is not an UploadFile, so FastAPI refuses it (422) before the handler runs;
    # read_masterlist_upload's own filename check (400) is the second line of defence.
    r = client.post("/api/v1/inventory/parse-file", headers=staff["boss"], files={"file": ("", b"Rice,Kitchen\n", "text/csv")})
    assert r.status_code == 422
