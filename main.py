
from fastapi import FastAPI

app = FastAPI(title="My First API")

@app.get("/")
def home():
    return {"message": "FastAPI is working!"}

@app.get("/health")
def health():
    return {"status": "ok"}
