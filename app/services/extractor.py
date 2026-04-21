import fitz  # PyMuPDF
import docx
import re
import zipfile

def extract_text_from_pdf(file_path: str) -> str:
    text = ""
    try:
        doc = fitz.open(file_path)
        for page in doc:
            text += page.get_text() + "\n"
        doc.close()
    except Exception as e:
        print(f"Error extracting PDF: {e}")
    return text

def extract_text_from_docx(file_path: str) -> str:
    text = ""
    try:
        doc = docx.Document(file_path)
        for para in doc.paragraphs:
            text += para.text + "\n"
    except Exception as e:
        print(f"Error extracting DOCX: {e}")
    return text


def extract_text_from_pptx(file_path: str) -> str:
    text_blocks = []
    try:
        with zipfile.ZipFile(file_path, "r") as pptx_zip:
            slide_files = sorted(
                [
                    name
                    for name in pptx_zip.namelist()
                    if name.startswith("ppt/slides/slide") and name.endswith(".xml")
                ]
            )

            for slide_file in slide_files:
                xml = pptx_zip.read(slide_file).decode("utf-8", errors="ignore")
                matches = re.findall(r"<a:t[^>]*>(.*?)</a:t>", xml)
                if not matches:
                    continue
                slide_text = " ".join(
                    re.sub(r"<[^>]+>", "", match).strip()
                    for match in matches
                    if match.strip()
                )
                if slide_text:
                    text_blocks.append(slide_text)
    except Exception as e:
        print(f"Error extracting PPTX: {e}")
    return "\n\n".join(text_blocks)


def extract_text_from_plaintext(file_path: str) -> str:
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        return f.read()

def extract_text(file_path: str, mime_type: str) -> str:
    if mime_type == "application/pdf":
        return extract_text_from_pdf(file_path)
    elif mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return extract_text_from_docx(file_path)
    elif mime_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        return extract_text_from_pptx(file_path)

    # Fallback for text/plain and unknown text-like files.
    return extract_text_from_plaintext(file_path)
