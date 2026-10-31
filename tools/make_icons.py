"""Gera os ícones PNG do Painel (sem bibliotecas externas): python tools/make_icons.py

- icon-192.png / icon-512.png: quadrado arredondado roxo com uma maleta branca e um ponto amarelo.
- maskable-512.png: fundo cheio, desenho dentro da zona segura (o Android recorta em círculo ou gota).
- badge-96.png: só a maleta, branca sobre transparente (ícone pequeno da barra de status do Android).
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
BG = (109, 40, 217)      # roxo forte: não se confunde com o azul do Telegram nem o verde do WhatsApp
FG = (255, 255, 255)
DOT = (255, 200, 61)
SS = 4                   # amostras por pixel em cada eixo (antisserrilhado)


def rrect(x, y, x0, y0, x1, y1, r):
    """Ponto dentro de um retângulo de cantos arredondados."""
    cx, cy = min(max(x, x0 + r), x1 - r), min(max(y, y0 + r), y1 - r)
    return x0 <= x <= x1 and y0 <= y <= y1 and (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def glyph(x, y, s=1.0, ox=0.0, oy=0.0):
    """Maleta em coordenadas 0..1, escalada por s em torno do centro e deslocada por (ox, oy)."""
    x, y = (x - 0.5 - ox) / s + 0.5, (y - 0.5 - oy) / s + 0.5
    body = rrect(x, y, 0.20, 0.36, 0.80, 0.76, 0.07)
    band = 0.52 <= y <= 0.565 and 0.20 <= x <= 0.80        # faixa recortada no meio da maleta
    clasp = rrect(x, y, 0.45, 0.50, 0.55, 0.60, 0.02)        # fecho por cima da faixa
    handle = rrect(x, y, 0.37, 0.22, 0.63, 0.40, 0.06) and not rrect(x, y, 0.42, 0.27, 0.58, 0.40, 0.025)
    return (body and not band) or clasp or handle


def render(size, kind):
    rows = []
    for py in range(size):
        row = bytearray([0])  # filtro PNG "nenhum"
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    x, y = (px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size
                    if kind == "badge":
                        color = FG if glyph(x, y, 1.15) else None
                    else:
                        s = 0.78 if kind == "maskable" else 1.0
                        inside = True if kind == "maskable" else rrect(x, y, 0.0, 0.0, 1.0, 1.0, 0.22)
                        if not inside:
                            color = None
                        elif (x - 0.5 - 0.30 * s) ** 2 + (y - 0.5 + 0.25 * s) ** 2 <= (0.10 * s) ** 2:
                            color = DOT
                        elif (x - 0.5 - 0.30 * s) ** 2 + (y - 0.5 + 0.25 * s) ** 2 <= (0.135 * s) ** 2:
                            color = BG     # contorno que separa o ponto da maleta
                        else:
                            color = FG if glyph(x, y, s) else BG
                    if color:
                        acc[0] += color[0]; acc[1] += color[1]; acc[2] += color[2]; acc[3] += 255
            n = SS * SS
            a = acc[3] / n
            rgb = [round(c / (acc[3] / 255)) if acc[3] else 0 for c in acc[:3]]
            row += bytes([*rgb, round(a)])
        rows.append(bytes(row))
    return png(size, b"".join(rows))


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 bits, RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, size, kind in (("icon-192.png", 192, "any"), ("icon-512.png", 512, "any"),
                             ("maskable-512.png", 512, "maskable"), ("badge-96.png", 96, "badge")):
        (OUT / name).write_bytes(render(size, kind))
        print(name)
