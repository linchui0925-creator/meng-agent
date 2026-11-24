#!/usr/bin/env python3
"""
dwg_pipeline.py — DWG/DXF 一站式勘察流水线

对单个图纸文件自动：
  1. 判定格式（DWG / DXF）
  2. DWG：容器级勘察（OLE 流、头部、版本、段表、对象表数量）
  3. 若本机有 dwgread（LibreDWG），自动转 DXF 后做内容分析
  4. 汇总成一份 JSON 报告

用法：
  python3 dwg_pipeline.py file.dwg
  python3 dwg_pipeline.py file.dwg --json report.json
  python3 dwg_pipeline.py dir/            # 批量目录
"""
import sys
import os
import json
import shutil
import subprocess
import tempfile
import hashlib
import binascii

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dwg_inspect  # noqa: E402
import dxf_inspect  # noqa: E402


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def convert_dwg_to_dxf(path: str, outdir: str) -> tuple:
    """用 LibreDWG 的 dwgread 转 DXF。返回 (dxf_path, cmd, err)"""
    exe = shutil.which("dwgread")
    if not exe:
        return None, None, "dwgread 未安装（brew install libredwg）"
    out = os.path.join(outdir, os.path.basename(path).rsplit(".", 1)[0] + ".dxf")
    cmd = [exe, "-O", "DXF", "-o", out, path]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if os.path.exists(out) and os.path.getsize(out) > 0:
            return out, " ".join(cmd), None
        return None, " ".join(cmd), (p.stderr or p.stdout)[-800:]
    except Exception as ex:  # noqa: BLE001
        return None, " ".join(cmd), str(ex)


def analyze_one(path: str) -> dict:
    ext = os.path.splitext(path)[1].lower()
    rep = {
        "file": path,
        "size": os.path.getsize(path),
        "sha256": sha256(path),
        "format": "dxf" if ext == ".dxf" else ("dwg" if ext == ".dwg" else "unknown"),
    }
    tmp = tempfile.mkdtemp(prefix="dwgpipe_")
    try:
        if ext == ".dwg":
            rep["container"] = dwg_inspect.inspect(path)
            dxf, cmd, err = convert_dwg_to_dxf(path, tmp)
            if dxf:
                rep["conversion"] = {"tool": cmd, "status": "ok"}
                rep["content"] = dxf_inspect.analyze(dxf, dump_text=True)
            else:
                rep["conversion"] = {"tool": cmd, "status": "failed", "error": err}
        elif ext == ".dxf":
            rep["content"] = dxf_inspect.analyze(path, dump_text=True)
        else:
            # 靠魔数判断
            head = open(path, "rb").read(8)
            if head[:6] in (b"AC1012", b"AC1014", b"AC1015", b"AC1018",
                            b"AC1021", b"AC1024", b"AC1027", b"AC1032"):
                rep["format"] = "dwg"
                rep["container"] = dwg_inspect.inspect(path)
            elif b"SECTION" in open(path, "rb").read(2048):
                rep["format"] = "dxf"
                rep["content"] = dxf_inspect.analyze(path, dump_text=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return rep


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return 1
    target = a[0]
    files = []
    if os.path.isdir(target):
        for root, _, names in os.walk(target):
            for n in names:
                if n.lower().endswith((".dwg", ".dxf")):
                    files.append(os.path.join(root, n))
    else:
        files = [target]

    reports = []
    for f in sorted(files):
        print(f"[*] 分析 {f}", file=sys.stderr)
        try:
            reports.append(analyze_one(f))
        except Exception as ex:  # noqa: BLE001
            reports.append({"file": f, "error": repr(ex)})

    out = {"generated_at": binascii.hexlify(os.urandom(4)).decode(),
           "count": len(reports), "reports": reports}
    if "--json" in a:
        p = a[a.index("--json") + 1]
        open(p, "w").write(json.dumps(out, indent=2, ensure_ascii=False))
        print("wrote", p)
    else:
        print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
