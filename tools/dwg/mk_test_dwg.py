#!/usr/bin/env python3
"""
mk_test_dwg.py — 合成一个最小可解析的 DWG 容器样本（用于自测与教学）

做两件事：
  1. 用纯 Python 写 OLE2/Compound File（512 字节扇区，单大流，免 miniFAT）
  2. 在流内构造一个 R2000 (AC1015) 风格的文件头 + 段表 + 对象表骨架

产出的 .dwg 能让 dwg_inspect.py 的 OLE 解析 + R13-R2000 头解析 + 对象表解析
三条路径都跑通，用来在没有 AutoCAD 的机器上验证工具链。

用法：
  python3 mk_test_dwg.py out.dwg
"""
import struct
import sys
import os

SECTOR = 512
ENDOFCHAIN = 0xFFFFFFFE
FREESECT = 0xFFFFFFFF
FATSECT = 0xFFFFFFFD
NOSTREAM = 0xFFFFFFFF


# ------------------------------------------------------------ OLE2 写入

def build_cfb(stream_name: str, payload: bytes) -> bytes:
    n_data = (len(payload) + SECTOR - 1) // SECTOR
    n_dir = 1
    payload = payload.ljust(n_data * SECTOR, b"\x00")

    # 解 FAT 扇区数（自洽迭代）
    n_fat = 1
    while True:
        total = n_data + n_dir + n_fat
        need = (total + (SECTOR // 4) - 1) // (SECTOR // 4)
        if need <= n_fat:
            break
        n_fat = need

    dir_sector = n_data
    fat_start = n_data + n_dir
    total_sectors = n_data + n_dir + n_fat

    fat = [FREESECT] * (n_fat * (SECTOR // 4))
    for i in range(n_data - 1):
        fat[i] = i + 1
    if n_data:
        fat[n_data - 1] = ENDOFCHAIN
    fat[dir_sector] = ENDOFCHAIN
    for i in range(n_fat):
        fat[fat_start + i] = FATSECT

    # 目录条目
    def dir_entry(name, obj_type, color, left, right, child, start, size):
        nm = name.encode("utf-16-le") + b"\x00\x00"
        assert len(nm) <= 64
        e = bytearray(128)
        e[0:len(nm)] = nm
        struct.pack_into("<H", e, 0x40, len(nm))
        e[0x42] = obj_type
        e[0x43] = color          # black
        struct.pack_into("<I", e, 0x44, left)
        struct.pack_into("<I", e, 0x48, right)
        struct.pack_into("<I", e, 0x4C, child)
        struct.pack_into("<I", e, 0x50, 0)      # CLSID
        struct.pack_into("<I", e, 0x54, 0)
        struct.pack_into("<I", e, 0x74, start)
        struct.pack_into("<Q", e, 0x78, size)
        return bytes(e)

    root = dir_entry("Root Entry", 5, 1, NOSTREAM, NOSTREAM, 1,
                     ENDOFCHAIN, 0)          # child -> 流条目
    # 名称排序：先比长度，再比大写。Root Entry(11) < AcFss...(18)，
    # 所以根的 child 指向 AcFssFileACAD_DWG（索引 1）
    stream_entry = dir_entry(stream_name, 2, 1, NOSTREAM, NOSTREAM, NOSTREAM,
                             0, len(payload))
    # 修正 root 的 child 指向索引 1
    root_b = bytearray(root)
    struct.pack_into("<I", root_b, 0x4C, 1)

    dirbytes = bytes(root_b) + stream_entry
    dirbytes = dirbytes.ljust(n_dir * SECTOR, b"\x00")

    # 头部
    hdr = bytearray(512)
    hdr[0:8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
    struct.pack_into("<H", hdr, 0x18, 0x003E)   # minor version
    struct.pack_into("<H", hdr, 0x1A, 0x0003)   # major version
    struct.pack_into("<H", hdr, 0x1C, 0xFFFE)   # byte order
    struct.pack_into("<H", hdr, 0x1E, 9)         # sector shift = 512
    struct.pack_into("<H", hdr, 0x20, 6)         # mini sector shift = 64
    struct.pack_into("<I", hdr, 0x2C, n_fat)
    struct.pack_into("<I", hdr, 0x30, dir_sector)
    struct.pack_into("<I", hdr, 0x38, 4096)      # mini stream cutoff
    struct.pack_into("<I", hdr, 0x3C, ENDOFCHAIN)
    struct.pack_into("<I", hdr, 0x40, 0)
    struct.pack_into("<I", hdr, 0x44, ENDOFCHAIN)
    struct.pack_into("<I", hdr, 0x48, 0)
    # DIFAT: 前 n_fat 项指向 FAT 扇区，其余 FREESECT
    difat = [FREESECT] * 109
    for i in range(n_fat):
        difat[i] = fat_start + i
    struct.pack_into("<109I", hdr, 0x4C, *difat)

    fatbytes = b"".join(struct.pack("<I", v) for v in fat)
    fatbytes = fatbytes.ljust(n_fat * SECTOR, b"\xff")

    return bytes(hdr) + payload + dirbytes + fatbytes


# ------------------------------------------------------------ R2000 头构造

def build_r2000_stream(num_objects: int = 12) -> bytes:
    """
    构造 R2000 (AC1015) 风格头部 + 段表 + 对象表骨架。
    字段偏移依据 ODA/LibreDWG 对 R13-R2000 文件头的逆向结论。
    """
    buf = bytearray(0x1000)

    buf[0:6] = b"AC1015"
    buf[0x06:0x0B] = b"\x00" * 5
    buf[0x0B] = 0x00
    buf[0x0C] = 0x00            # 无预览图
    buf[0x11] = 0x00            # app version
    buf[0x12] = 0x00            # app maint version
    buf[0x13] = 30              # codepage (ANSI 1252)
    buf[0x14] = 0x00

    # 段定位器扇区（相对 0x100 偏移的扇区号）
    struct.pack_into("<I", buf, 0x15, 0)
    buf[0x19] = 0x20
    struct.pack_into("<I", buf, 0x1A, 0x12345678)   # CRC(占位)
    struct.pack_into("<I", buf, 0x1E, 0)

    struct.pack_into("<I", buf, 0x22, 0x0100)       # section page map addr
    struct.pack_into("<I", buf, 0x26, 0x0020)       # size
    buf[0x2A] = 0x00
    struct.pack_into("<I", buf, 0x2B, 0x0A0B0C0D)   # CRC

    struct.pack_into("<I", buf, 0x31, 0x0120)       # section map addr
    struct.pack_into("<I", buf, 0x35, 0x0040)       # size
    buf[0x39] = 0x00
    struct.pack_into("<I", buf, 0x3A, 0x0A0B0C0E)   # CRC

    struct.pack_into("<I", buf, 0x42, 0x0200)       # header vars addr
    struct.pack_into("<I", buf, 0x46, 0x0100)
    buf[0x4A] = 0x00
    struct.pack_into("<I", buf, 0x4B, 0x0A0B0C10)

    struct.pack_into("<I", buf, 0x50, 0x0300)       # 副 header addr
    struct.pack_into("<I", buf, 0x54, 0x0080)
    buf[0x58] = 0x00
    struct.pack_into("<I", buf, 0x59, 0x0A0B0C12)

    struct.pack_into("<I", buf, 0x61, 0x0400)       # aux header addr
    struct.pack_into("<I", buf, 0x65, 0x0100)
    buf[0x69] = 0x00
    struct.pack_into("<I", buf, 0x6A, 0x0A0B0C14)

    struct.pack_into("<I", buf, 0x70, 0)            # 缩略图 addr
    struct.pack_into("<I", buf, 0x74, 0)

    # ---- 对象表 (object map) ----
    om_off = 0x0600
    struct.pack_into("<I", buf, 0x80, om_off)       # object map offset
    struct.pack_into("<I", buf, 0x84, 0x00C0)       # object map size
    buf[0x88] = 0x00
    struct.pack_into("<I", buf, 0x89, 0x0A0B0C16)   # CRC

    o = om_off
    buf[o + 0x00] = 0x00
    buf[o + 0x01] = 0x00
    struct.pack_into("<I", buf, o + 0x02, 0x20)     # size
    struct.pack_into("<I", buf, o + 0x06, 0x30)
    buf[o + 0x0A] = 0x00
    struct.pack_into("<I", buf, o + 0x0C, num_objects)  # num objects
    buf[o + 0x10] = 0x00
    struct.pack_into("<I", buf, o + 0x12, 0x0700)   # handles section offset
    struct.pack_into("<I", buf, o + 0x18, 0x0080)   # handles size
    struct.pack_into("<I", buf, o + 0x1C, num_objects)
    struct.pack_into("<I", buf, o + 0x28, 0x0780)   # objects section offset
    struct.pack_into("<I", buf, o + 0x2E, 0x0080)
    struct.pack_into("<I", buf, o + 0x32, num_objects)

    # 句柄对表：每 8 字节 (offset, size)
    base = o + 0x36
    for i in range(num_objects):
        struct.pack_into("<II", buf, base + i * 8,
                         0x0800 + i * 0x40, 0x0040)

    # handles 区
    for i in range(num_objects):
        struct.pack_into("<II", buf, 0x0700 + i * 8, i, 0x0800 + i * 0x40)

    # objects 区：每个对象塞一个可识别标记
    for i in range(num_objects):
        p = 0x0800 + i * 0x40
        buf[p:p + 8] = b"TESTOBJ\x00"
        struct.pack_into("<I", buf, p + 8, i)

    return bytes(buf)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "test_r2000.dwg"
    stream = build_r2000_stream()
    data = build_cfb("AcFssFileACAD_DWG", stream)
    with open(out, "wb") as f:
        f.write(data)
    print(f"wrote {out} ({len(data)} bytes, stream {len(stream)} bytes)")


if __name__ == "__main__":
    main()
