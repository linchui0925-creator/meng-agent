#!/usr/bin/env python3
"""
dxg_inspect.py — DXF 图纸内容分析器（基于 ezdxf）

功能：
  - 图层清单（颜色、线型、开关状态、打印开关）
  - 块定义与块引用统计
  - 实体类型分布
  - 标注文字抽取
  - 坐标范围（modelspace bbox）
  - 命名对象（样式/标注样式/视口/布局）

用法：
  python3 dxg_inspect.py file.dxf [--dump-text] [--json out.json]
"""
import sys
import json
import os
from collections import Counter, defaultdict

os.environ.setdefault("EZDXF_NO_CACHE", "1")
import ezdxf  # noqa: E402
from ezdxf.document import Drawing  # noqa: E402


def layer_info(doc: Drawing) -> list:
    out = []
    for layer in doc.layers:
        out.append({
            "name": layer.dxf.name,
            "color": layer.dxf.color,
            "linetype": layer.dxf.linetype,
            "on": layer.is_on(),
            "frozen": layer.is_frozen(),
            "locked": layer.is_locked(),
            "plot": layer.dxf.plot,
        })
    return out


def block_info(doc: Drawing) -> dict:
    defined, refs = [], Counter()
    for blk in doc.blocks:
        if blk.name.startswith("*"):
            continue
        ents = list(blk)
        defined.append({
            "name": blk.name,
            "entity_count": len(ents),
            "types": dict(Counter(e.dxftype() for e in ents)),
        })
    for e in doc.modelspace():
        if e.dxftype() == "INSERT":
            refs[e.dxf.name] += 1
    return {"defined": defined, "references": dict(refs)}


def entity_stats(doc: Drawing) -> dict:
    stats = {"modelspace": {}, "paperspace": {}}
    spaces = [("modelspace", doc.modelspace())]
    for lay in doc.layouts:
        if lay.name.lower().startswith("paper_space"):
            spaces.append((lay.name, lay))
    for key, space in spaces:
        if space is None:
            continue
        c = Counter(e.dxftype() for e in space)
        stats[key] = dict(c.most_common())
    # 按图层统计实体
    by_layer = defaultdict(Counter)
    for e in doc.modelspace():
        by_layer[e.dxf.layer][e.dxftype()] += 1
    stats["by_layer"] = {k: dict(v) for k, v in by_layer.items()}
    return stats


def text_dump(doc: Drawing, limit: int = 5000) -> list:
    out = []
    spaces = [("M", doc.modelspace())]
    for lay in doc.layouts:
        if lay.name.lower().startswith("paper_space"):
            spaces.append((lay.name, lay))
    for space_name, space in spaces:
        if space is None:
            continue
        for e in space:
            t = e.dxftype()
            if t == "TEXT":
                out.append({"space": space_name, "type": t, "layer": e.dxf.layer,
                            "text": e.dxf.text, "insert": tuple(round(v, 4) for v in e.dxf.insert)})
            elif t == "MTEXT":
                out.append({"space": space_name, "type": t, "layer": e.dxf.layer,
                            "text": e.plain_text()[:500],
                            "insert": tuple(round(v, 4) for v in e.dxf.insert)})
            elif t == "ATTRIB":
                out.append({"space": space_name, "type": t, "layer": e.dxf.layer,
                            "text": e.dxf.text, "tag": e.dxf.tag})
            elif t == "DIMENSION":
                out.append({"space": space_name, "type": t, "layer": e.dxf.layer,
                            "text": getattr(e.dxf, "text", "")})
            if len(out) >= limit:
                return out
    return out


def bbox(doc: Drawing):
    try:
        from ezdxf import bbox as _b
        ext = _b.extents(doc.modelspace())
        return {"min": tuple(round(v, 4) for v in ext.extmin),
                "max": tuple(round(v, 4) for v in ext.extmax)}
    except Exception as ex:  # noqa: BLE001
        return {"error": str(ex)}


def named_objects(doc: Drawing) -> dict:
    return {
        "dimstyles": sorted(d.dxf.name for d in doc.dimstyles),
        "textstyle": sorted(s.dxf.name for s in doc.styles),
        "linetypes": sorted(l.dxf.name for l in doc.linetypes),
        "layouts": [l.name for l in doc.layouts],
        "blocks_count": len(list(doc.blocks)),
    }


def analyze(path: str, dump_text: bool) -> dict:
    doc = ezdxf.readfile(path)
    out = {
        "file": path,
        "dxfversion": doc.dxfversion,
        "acad_release": doc.acad_release,
        "encoding": doc.encoding,
        "units": doc.units,
        "header_insunits": doc.header.get("$INSUNITS", None),
        "layers": layer_info(doc),
        "blocks": block_info(doc),
        "entities": entity_stats(doc),
        "bbox": bbox(doc),
        "named_objects": named_objects(doc),
    }
    if dump_text:
        out["texts"] = text_dump(doc)
    return out


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return 1
    path = a[0]
    dump = "--dump-text" in a
    res = analyze(path, dump)
    if "--json" in a:
        p = a[a.index("--json") + 1]
        open(p, "w").write(json.dumps(res, indent=2, ensure_ascii=False))
        print("wrote", p)
    else:
        print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
