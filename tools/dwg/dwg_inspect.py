#!/usr/bin/env python3
"""
dwg_inspect.py — 纯 Python DWG 二进制结构勘察器（无第三方依赖）

目标版本线：
  R13-R2000 (AC1012-AC1015)   : 头部 + Section Locator + Object Map
  R2004+     (AC1018-AC1032)  : 头部 + 加密页表信息（0x6c 页映射表结构解析）

用法：
  python3 dwg_inspect.py file.dwg
  python3 dwg_inspect.py file.dwg --json out.json
"""
import sys
import struct
import json
import binascii
import zlib

# ---------------------------------------------------------------- OLE (CFB)

SIG = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ENDOFCHAIN = 0xFFFFFFFE
FREESECT = 0xFFFFFFFF
FATSECT = 0xFFFFFFFD
DIFSECT = 0xFFFFFFFC


class Ole:
    """最小 OLE2 / Compound File Binary 读取器。"""

    def __init__(self, data: bytes):
        if data[:8] != SIG:
            raise ValueError("not an OLE2 compound file (DWG R2004+ 容器)")
        self.d = data
        self.sector_shift = struct.unpack_from("<H", data, 0x1E)[0]
        self.mini_shift = struct.unpack_from("<H", data, 0x20)[0]
        self.sector_size = 1 << self.sector_shift
        self.mini_size = 1 << self.mini_shift
        self.num_fat = struct.unpack_from("<I", data, 0x2C)[0]
        self.dir_start = struct.unpack_from("<I", data, 0x30)[0]
        self.mini_cutoff = struct.unpack_from("<I", data, 0x38)[0]
        self.mini_fat_start = struct.unpack_from("<I", data, 0x3C)[0]
        self.num_mini_fat = struct.unpack_from("<I", data, 0x40)[0]
        self.difat_start = struct.unpack_from("<I", data, 0x44)[0]
        self.num_difat = struct.unpack_from("<I", data, 0x48)[0]
        self._read_difat()
        self._read_fat()
        self._read_dir()

    # -- 扇区 ---------------------------------------------------------
    def sector_off(self, sid: int) -> int:
        return 512 + sid * self.sector_size

    def sector(self, sid: int) -> bytes:
        off = self.sector_off(sid)
        return self.d[off:off + self.sector_size]

    def _read_difat(self):
        self.difat = list(struct.unpack_from("<109I", self.d, 0x4C))
        sid, cnt = self.difat_start, self.num_difat
        guard = 0
        while sid not in (ENDOFCHAIN, FREESECT) and cnt > 0 and guard < 10000:
            sec = self.sector(sid)
            n = (self.sector_size // 4) - 1
            self.difat.extend(struct.unpack_from("<%dI" % n, sec, 0))
            sid = struct.unpack_from("<I", sec, n * 4)[0]
            cnt -= 1
            guard += 1
        self.difat = [s for s in self.difat if s != FREESECT]

    def _read_fat(self):
        self.fat = []
        for sid in self.difat[: self.num_fat]:
            sec = self.sector(sid)
            self.fat.extend(struct.unpack_from("<%dI" % (self.sector_size // 4), sec, 0))

    def chain(self, start: int) -> list:
        out, sid, guard = [], start, 0
        while sid not in (ENDOFCHAIN, FREESECT) and sid < len(self.fat) and guard < 200000:
            out.append(sid)
            sid = self.fat[sid]
            guard += 1
        return out

    def read_chain(self, start: int, size: int | None = None) -> bytes:
        buf = b"".join(self.sector(s) for s in self.chain(start))
        return buf[:size] if size is not None else buf

    # -- 目录 ---------------------------------------------------------
    def _read_dir(self):
        raw = self.read_chain(self.dir_start)
        self.entries = []
        for i in range(0, len(raw) - 127, 128):
            e = raw[i:i + 128]
            nlen = struct.unpack_from("<H", e, 0x40)[0]
            if nlen == 0:
                continue
            name = e[: max(0, nlen - 2)].decode("utf-16-le", "replace")
            objtype = e[0x42]
            start = struct.unpack_from("<I", e, 0x74)[0]
            size = struct.unpack_from("<Q", e, 0x78)[0]
            left = struct.unpack_from("<I", e, 0x44)[0]
            right = struct.unpack_from("<I", e, 0x48)[0]
            child = struct.unpack_from("<I", e, 0x4C)[0]
            self.entries.append(
                dict(idx=len(self.entries), name=name, type=objtype, start=start,
                     size=size, left=left, right=right, child=child))
        self.by_name = {e["name"]: e for e in self.entries}

    def read_entry(self, e: dict) -> bytes:
        if e["size"] < self.mini_cutoff:
            mini = self.read_chain(self.mini_fat_start)
            out, sid = b"", e["start"]
            guard = 0
            while sid not in (ENDOFCHAIN, FREESECT) and guard < 100000:
                out += mini[sid * self.mini_size:(sid + 1) * self.mini_size]
                sid = struct.unpack_from("<I", mini, sid * 4)[0]
                guard += 1
            return out[: e["size"]]
        return self.read_chain(e["start"], e["size"])


# ---------------------------------------------------------------- 版本表

VERSIONS = {
    "AC1012": "R13", "AC1014": "R14", "AC1015": "AutoCAD 2000",
    "AC1018": "AutoCAD 2004", "AC1021": "AutoCAD 2007", "AC1024": "AutoCAD 2010",
    "AC1027": "AutoCAD 2013", "AC1032": "AutoCAD 2018+",
}

DWG_MAGICS = [b"AC1012", b"AC1014", b"AC1015", b"AC1018", b"AC1021",
              b"AC1024", b"AC1027", b"AC1032"]


def detect_version(raw: bytes) -> str:
    for m in DWG_MAGICS:
        if raw.startswith(m):
            return m.decode()
    return "UNKNOWN"


# ---------------------------------------------------------------- R13-R2000 头

def parse_r13_2000(raw: bytes) -> dict:
    """
    R13-R2000 DWG 头部布局（来自 ODA / LibreDWG 逆向结论）：
      0x00  6B  版本魔数 "AC10xx"
      0x06  5B  5 个 0x00 填充
      0x0B  1B  0x00 / 0x01  (维护版本)
      0x0C  6B  5B  预览地址（AcDb:Preview，0x00 表示无）
      0x11  1B  app version
      0x12  1B  app maint version
      0x13  1B  codepage
      0x14  1B  0x00
      0x15  4B  Section locator record 所在扇区号（相对 0x100）
      0x19  1B  0x20
      0x1A  4B  Section locator record 的 CRC
      0x1E  4B  0x00
      0x22  4B  Section page map 地址
      0x26  4B  Section page map 大小
      0x2A  1B  0x00
      0x2B  4B  Section page map CRC
      0x2F  2B  0x00
      0x31  4B  Section map 地址
      0x35  4B  Section map 大小
      0x39  1B  0x00
      0x3A  4B  Section map CRC
      0x3E  4B  0x00
      0x42  4B  Section info（Header variables）地址
      0x46  4B  Section info 大小
      0x4A  1B  0x00
      0x4B  4B  Section info CRC
      0x4F  1B  0x00
      0x50  4B  副 header 地址
      0x54  4B  副 header 大小
      0x58  1B  0x00
      0x59  4B  副 header CRC
      0x5D  4B  0x00
      0x61  4B  Aux header 地址
      0x65  4B  Aux header 大小
      0x69  1B  0x00
      0x6A  4B  Aux header CRC
      0x6E  2B  0x00
      0x70  4B  缩略图地址
      0x74  4B  缩略图大小
      ...
      0x80  4B  object map 起始偏移（相对文件头）
      0x84  4B  object map 大小
      0x88  1B  0x00
      0x89  4B  object map CRC
    """
    o = {}
    o["version"] = raw[:6].decode("ascii", "replace")
    o["codepage"] = raw[0x13]
    o["section_locator_sector"] = struct.unpack_from("<I", raw, 0x15)[0]
    o["section_page_map_addr"] = struct.unpack_from("<I", raw, 0x22)[0]
    o["section_page_map_size"] = struct.unpack_from("<I", raw, 0x26)[0]
    o["section_map_addr"] = struct.unpack_from("<I", raw, 0x31)[0]
    o["section_map_size"] = struct.unpack_from("<I", raw, 0x35)[0]
    o["header_vars_addr"] = struct.unpack_from("<I", raw, 0x42)[0]
    o["header_vars_size"] = struct.unpack_from("<I", raw, 0x46)[0]
    o["aux_header_addr"] = struct.unpack_from("<I", raw, 0x61)[0]
    o["aux_header_size"] = struct.unpack_from("<I", raw, 0x65)[0]
    o["thumbnail_addr"] = struct.unpack_from("<I", raw, 0x70)[0]
    o["thumbnail_size"] = struct.unpack_from("<I", raw, 0x74)[0]
    o["object_map_offset"] = struct.unpack_from("<I", raw, 0x80)[0]
    o["object_map_size"] = struct.unpack_from("<I", raw, 0x84)[0]
    o["_crc"] = {
        "section_locator": "%08X" % struct.unpack_from("<I", raw, 0x1A)[0],
        "section_page_map": "%08X" % struct.unpack_from("<I", raw, 0x2B)[0],
        "section_map": "%08X" % struct.unpack_from("<I", raw, 0x3A)[0],
        "header_vars": "%08X" % struct.unpack_from("<I", raw, 0x4B)[0],
        "object_map": "%08X" % struct.unpack_from("<I", raw, 0x89)[0],
    }
    return o


# ---------------------------------------------------------------- R2004+ 头

def parse_r2004(raw: bytes) -> dict:
    """
    R2004+ 文件头（"AcFssFileACAD_DWG"）：
      0x00  6B  "AC10xx"
      0x06  8B  加密头
      0x0E  1B  0x00
      0x0F  1B  0x01
      0x10  1B  0x00
      0x11  1B  0x00
      0x12  1B  0x00
      0x13  1B  0x00
      0x14  1B  0x00
      0x15  1B  0x00
      0x16  4B  解密后的文件头 CRC
      0x1A  4B  解密后的文件头 CRC2
      0x1E  4B  0x00
      0x22  4B  0x80
      0x26  4B  0x40
      0x2A  4B  0x20
      0x2E  1B  0x00
      0x2F  8B  0x00
      0x37  4B  文件头大小（0x80）
      0x3B  4B  0x6C
      0x3F  4B  4 (元数据映射页数)
      0x43  4B  0x6C
      0x47  4B  section page map 地址
      0x4B  4B  section page map 大小
      0x4F  4B  0x00
      0x53  4B  0x00
      0x57  1B  0x02
      0x58  1B  0x00
      0x59  1B  0x20
      0x5A  1B  0x80
      0x5B  1B  0x00
      0x5C  4B  section 页大小
      0x60  4B  0x00
      0x64  4B  0x40
      0x68  4B  0x20
      0x6C  ... 0x6C 页 (Section Page Map)
    """
    o = {}
    o["version"] = raw[:6].decode("ascii", "replace")
    o["encrypted_header_size"] = 0x6C
    o["meta_data_map_pages"] = struct.unpack_from("<I", raw, 0x3F)[0]
    o["section_page_map_addr"] = struct.unpack_from("<I", raw, 0x47)[0]
    o["section_page_map_size"] = struct.unpack_from("<I", raw, 0x4B)[0]
    o["section_page_size"] = struct.unpack_from("<I", raw, 0x5C)[0]
    o["r2004_page_map"] = raw[0x6C:0x6C + 0x40].hex()
    return o


# ---------------------------------------------------------------- Object Map

def parse_object_map(raw: bytes, off: int, size: int) -> dict:
    """
    R13-R2000 Object map:
      0x00 2B 0x00 0x00
      0x02 4B 0x20 (size)
      0x06 4B 0x30 (unknown)
      0x0A 2B 0x00
      0x0C 4B  (num objects)
      0x10 2B  0x00
      0x12 4B  (handles section offset)
      0x16 2B  0x00
      0x18 4B  (handles section size)
      0x1C 4B  (handles section count)
      0x20 8B  0x00
      0x28 4B  (objects section offset)
      0x2C 2B  0x00
      0x2E 4B  (objects section size)
      0x32 4B  (objects section count)
      0x36 ...  句柄对 (offset,size) 数组
    """
    res = {"num_objects": None, "handles": {}, "objects": {}}
    if off + 0x40 > len(raw):
        return res
    try:
        res["num_objects"] = struct.unpack_from("<I", raw, off + 0x0C)[0]
        h_off = struct.unpack_from("<I", raw, off + 0x12)[0]
        h_size = struct.unpack_from("<I", raw, off + 0x18)[0]
        h_cnt = struct.unpack_from("<I", raw, off + 0x1C)[0]
        o_off = struct.unpack_from("<I", raw, off + 0x28)[0]
        o_size = struct.unpack_from("<I", raw, off + 0x2E)[0]
        o_cnt = struct.unpack_from("<I", raw, off + 0x32)[0]
        res["handle_section"] = {"offset": h_off, "size": h_size, "count": h_cnt}
        res["object_section"] = {"offset": o_off, "size": o_size, "count": o_cnt}

        # 句柄对表：从 0x36 起，每 8 字节 (offset:u32, size:u32)
        base = off + 0x36
        for i in range(min(o_cnt, 4096)):
            p = base + i * 8
            if p + 8 > len(raw):
                break
            oo, ss = struct.unpack_from("<II", raw, p)
            res["objects"][i] = {"offset": oo, "size": ss}
    except Exception as ex:  # noqa: BLE001
        res["error"] = str(ex)
    return res


# ---------------------------------------------------------------- 主流程

def inspect(path: str) -> dict:
    data = open(path, "rb").read()
    out = {"file": path, "size": len(data), "sha256": binascii.hexlify(
        __import__("hashlib").sha256(data).digest()).decode()}

    if data[:8] == SIG:
        out["container"] = "OLE2 (Compound File)"
        ole = Ole(data)
        out["ole"] = {
            "sector_size": ole.sector_size,
            "mini_sector_size": ole.mini_size,
            "num_fat_sectors": ole.num_fat,
            "entries": [
                {"name": e["name"], "type": e["type"], "size": e["size"]}
                for e in ole.entries if e["type"] in (1, 2, 5)
            ],
        }
        # 找到 DWG 主数据流
        main = None
        for cand in ("AcFssFileACAD_DWG", "AcFssFileCAD_DWG"):
            if cand in ole.by_name:
                main = ole.read_entry(ole.by_name[cand])
                break
        if main is None:
            for e in ole.entries:
                if e["type"] == 2 and e["size"] > 128:
                    main = ole.read_entry(e)
                    break
        if main:
            out["container_detail"] = "OLE2 wrapper: 头部与数据段被拆成多个流"
            raw = main      # 偏移量相对主数据流
            head = main[:0x100]
        else:
            raw = data
            head = data[:0x100]
    else:
        out["container"] = "raw"
        head = data[:0x100]
        raw = data

    ver = detect_version(head)
    out["dwg_version"] = ver
    out["dwg_release"] = VERSIONS.get(ver, "?")

    if ver.startswith("AC1018") or ver.startswith("AC102") :
        out["header"] = parse_r2004(head)
        out["note"] = ("R2004+ 头部经 0x6C 变位混淆与 128 字节块异或加密，"
                       "本页解析只做容器与页表布局；完整段解压需 LibreDWG/ODA。")
    else:
        out["header"] = parse_r13_2000(head)
        om = parse_object_map(raw, out["header"]["object_map_offset"],
                              out["header"]["object_map_size"])
        out["object_map"] = om
        out["note"] = "R13-R2000：头部/段表/对象表已解析；实体内容需解位流。"

    return out


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    path = args[0]
    data = inspect(path)
    if "--json" in args:
        p = args[args.index("--json") + 1]
        open(p, "w").write(json.dumps(data, indent=2, ensure_ascii=False))
        print("wrote", p)
    else:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
