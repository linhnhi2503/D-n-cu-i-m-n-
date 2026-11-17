import json
import os
import io
from datetime import datetime
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any, List

from agents.orchestrator import ThienMinhSalesWorkflowOrchestrator
from agents.file_parser import DocumentParser
from agents.exporter import ProposalExporter

app = FastAPI(title="Thiên Minh B2B AI Agent Workflow", version="2.5.0")

orchestrator = ThienMinhSalesWorkflowOrchestrator()

UPLOAD_DIR = os.path.abspath("uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

latest_result_cache: Dict[str, Any] = {}

class RFPRequest(BaseModel):
    title: Optional[str] = "Hồ sơ yêu cầu chào giá"
    client_name: Optional[str] = "Khách hàng Doanh nghiệp"
    contact_person: Optional[str] = "Đại diện"
    content: str
    location: Optional[str] = None
    discount_pct: Optional[float] = None

@app.get("/api/samples")
def get_samples():
    if os.path.exists("data/sample_rfps.json"):
        with open("data/sample_rfps.json", "r", encoding="utf-8") as f:
            return json.load(f)
    return []

@app.get("/api/rfqs")
def get_rfq_list(q: Optional[str] = None, limit: int = 200):
    rfq_path = "data/rfq_requirements_200.json"
    if not os.path.exists(rfq_path):
        return []
    with open(rfq_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if q:
        query = q.lower().strip()
        data = [r for r in data if query in r["rfq_id"].lower() or query in r["customer"].lower() or query in r["location"].lower()]
    return data[:limit]

@app.get("/api/rfqs/{rfq_id}")
def analyze_specific_rfq(rfq_id: str):
    rfq_path = "data/rfq_requirements_200.json"
    if not os.path.exists(rfq_path):
        raise HTTPException(status_code=404, detail="Chưa có dữ liệu RFQ.")
    with open(rfq_path, "r", encoding="utf-8") as f:
        rfqs = json.load(f)
    
    target = next((r for r in rfqs if r["rfq_id"].upper() == rfq_id.upper()), None)
    if not target:
        raise HTTPException(status_code=404, detail=f"Không tìm thấy {rfq_id}.")
    
    result = orchestrator.run(
        rfp_text=target["content"],
        metadata={
            "client_name": target["customer"],
            "contact_person": "Ban QLDA / Mua sắm",
            "title": f"Dự án {target['rfq_id']} - {target['customer']}",
            "location": target["location"],
            "deployment_deadline": target.get("deployment_deadline"),
            "maintenance_requirement": target.get("maintenance_requirement")
        }
    )
    result["rfq_id"] = target["rfq_id"]
    result["expected_evaluation"] = target.get("expected_evaluation")
    result["followup_tasks"] = target.get("followup_tasks", [])
    result["benchmark_quotation"] = target.get("benchmark_quotation")
    
    global latest_result_cache
    latest_result_cache = result
    return result

@app.get("/api/catalog")
def get_catalog():
    if os.path.exists("data/catalog_solutions.json"):
        with open("data/catalog_solutions.json", "r", encoding="utf-8") as f:
            return json.load(f)
    return {"solutions": []}

@app.get("/api/policies")
def get_policies():
    if os.path.exists("data/approval_policies.json"):
        with open("data/approval_policies.json", "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

@app.get("/api/operations")
def get_operations():
    if os.path.exists("data/schedule_capacity.json"):
        with open("data/schedule_capacity.json", "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

@app.get("/api/files")
def get_uploaded_files():
    files_info = []
    if os.path.exists(UPLOAD_DIR):
        for fname in os.listdir(UPLOAD_DIR):
            fpath = os.path.join(UPLOAD_DIR, fname)
            if os.path.isfile(fpath):
                stat = os.stat(fpath)
                ext = fname.lower().split('.')[-1] if '.' in fname else 'unknown'
                files_info.append({
                    "filename": fname,
                    "size_bytes": stat.st_size,
                    "size_formatted": f"{(stat.st_size / 1024):.1f} KB" if stat.st_size < 1024*1024 else f"{(stat.st_size / (1024*1024)):.2f} MB",
                    "extension": ext,
                    "uploaded_at": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                })
    files_info.sort(key=lambda x: x["uploaded_at"], reverse=True)
    return {"files": files_info, "total": len(files_info)}

@app.post("/api/upload-and-analyze")
async def upload_and_analyze(file: UploadFile = File(...)):
    try:
        content_bytes = await file.read()
        safe_filename = file.filename.replace(" ", "_")
        dest_path = os.path.join(UPLOAD_DIR, safe_filename)
        with open(dest_path, "wb") as f:
            f.write(content_bytes)

        ext = safe_filename.lower().split('.')[-1]
        guessed_client = safe_filename.rsplit('.', 1)[0].replace('_', ' ')
        location = None
        deadline_str = None

        if ext in ['xlsx', 'xls']:
            try:
                import openpyxl
                wb = openpyxl.load_workbook(io.BytesIO(content_bytes), data_only=True)
                if 'RFQ_Requirements' in wb.sheetnames:
                    ws = wb['RFQ_Requirements']
                    rows = list(ws.iter_rows(values_only=True))
                    if len(rows) > 1:
                        first_rfq_id = rows[1][0]
                        first_cust = rows[1][1] or "Khách hàng Doanh nghiệp"
                        first_loc = rows[1][4] or "Hà Nội"
                        deadline_val = rows[1][5]
                        deadline_str = deadline_val.strftime("%Y-%m-%d") if hasattr(deadline_val, 'strftime') else str(deadline_val)
                        maint = rows[1][6] or "12 tháng; hỗ trợ 8x5"
                        
                        rfq_rows = [r for r in rows[1:] if r[0] == first_rfq_id]
                        items_desc = "\n".join([f"- {r[3]} thiết bị {r[2]}" for r in rfq_rows])
                        extracted_text = f"""Hồ sơ yêu cầu chào giá dự án: {first_rfq_id}
Khách hàng: {first_cust}
Địa điểm triển khai: {first_loc}
Danh mục thiết bị yêu cầu:
{items_desc}
Hạn hoàn thành thi công nghiệm thu: {deadline_str}
Yêu cầu dịch vụ bảo trì: {maint}
Đề xuất chiết khấu thương mại: 8%"""
                        guessed_client = first_cust
                        location = first_loc
                else:
                    extracted_text = DocumentParser.parse_file(safe_filename, content_bytes)
            except Exception:
                extracted_text = DocumentParser.parse_file(safe_filename, content_bytes)
        else:
            extracted_text = DocumentParser.parse_file(safe_filename, content_bytes)

        result = orchestrator.run(
            rfp_text=extracted_text,
            metadata={
                "client_name": guessed_client,
                "contact_person": "Ban Quản lý Dự án",
                "title": f"Hồ sơ thầu: {guessed_client}",
                "location": location,
                "deployment_deadline": deadline_str
            }
        )
        result["filename"] = safe_filename
        result["filesize"] = f"{(len(content_bytes) / 1024):.1f} KB"
        result["extracted_raw_text"] = extracted_text

        global latest_result_cache
        latest_result_cache = result
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/dataset/1000")
def get_full_1000_dataset():
    """Trả về toàn bộ 1.000 dòng dữ liệu mẫu chuẩn của Công ty Thiên Minh"""
    json_path = "data/full_1000_dataset.json"
    if not os.path.exists(json_path):
        raise HTTPException(status_code=404, detail="Chưa có tệp full_1000_dataset.json")
    with open(json_path, "r", encoding="utf-8") as f:
        return json.load(f)

@app.get("/api/export-csv")
def export_cleaned_csv():
    """Tải tệp CSV 1.000 dòng dữ liệu đã được làm sạch và chuẩn hóa"""
    csv_path = "data/cleaned_1000_dataset.csv"
    if not os.path.exists(csv_path):
        raise HTTPException(status_code=404, detail="Chưa có tệp CSV làm sạch.")
    return FileResponse(
        path=csv_path,
        filename="Du_lieu_1000_dong_da_lam_sach_ThienMinh.csv",
        media_type="text/csv"
    )

@app.get("/api/export-excel")
def export_excel(rfq_id: Optional[str] = None):
    global latest_result_cache
    if rfq_id:
        analyze_specific_rfq(rfq_id)
    elif not latest_result_cache:
        analyze_specific_rfq("RFQ-001")
    
    excel_bytes = ProposalExporter.export_excel(
        proposal_data=latest_result_cache.get("proposal", {}),
        extracted_data=latest_result_cache.get("extracted_data", {}),
        pricing_data=latest_result_cache.get("pricing", {})
    )
    
    filename = f"Bao_gia_{latest_result_cache.get('rfq_id', 'ThienMinh')}.xlsx"
    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@app.get("/api/export-word")
def export_word(rfq_id: Optional[str] = None):
    global latest_result_cache
    if rfq_id:
        analyze_specific_rfq(rfq_id)
    elif not latest_result_cache:
        analyze_specific_rfq("RFQ-001")
    
    word_bytes = ProposalExporter.export_word(
        proposal_data=latest_result_cache.get("proposal", {}),
        extracted_data=latest_result_cache.get("extracted_data", {}),
        pricing_data=latest_result_cache.get("pricing", {}),
        schedule_data=latest_result_cache.get("schedule", {})
    )
    
    filename = f"De_xuat_ky_thuat_{latest_result_cache.get('rfq_id', 'ThienMinh')}.docx"
    return Response(
        content=word_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_root():
    return FileResponse("static/index.html")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
