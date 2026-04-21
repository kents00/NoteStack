import os
import shutil
from fastapi import UploadFile

UPLOAD_DIR = "uploads"

if not os.path.exists(UPLOAD_DIR):
    os.makedirs(UPLOAD_DIR)

async def save_upload_file(upload_file: UploadFile, destination_path: str) -> str:
    """Save an uploaded file to the local filesystem."""
    try:
        file_location = os.path.join(UPLOAD_DIR, destination_path)
        with open(file_location, "wb+") as file_object:
            shutil.copyfileobj(upload_file.file, file_object)
        return file_location
    finally:
        upload_file.file.close()

def get_file_path(filename: str) -> str:
    return os.path.join(UPLOAD_DIR, filename)
