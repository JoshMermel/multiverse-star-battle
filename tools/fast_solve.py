"""fast_solve.py -- ctypes wrapper around fast_solve.c (built on first import into tools/_build/).
solutions2(grid, n, cap) -> list of solution strings ('x'/'.', row-major), or None if >= cap solutions exist (2 stars per row/col/region only)."""
import ctypes, os, subprocess
_HERE = os.path.dirname(os.path.abspath(__file__))
_SO = os.path.join(_HERE, "_build", "fast_solve.so")
_SRC = os.path.join(_HERE, "fast_solve.c")
if not os.path.exists(_SO) or os.path.getmtime(_SO) < os.path.getmtime(_SRC):
    os.makedirs(os.path.dirname(_SO), exist_ok=True)
    subprocess.run(["cc", "-O2", "-shared", "-fPIC", "-o", _SO, _SRC], check=True)
_lib = ctypes.CDLL(_SO)
_lib.solve2.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_char_p]
_lib.solve2.restype = ctypes.c_int


def solutions2(grid, n, cap=4000):
    buf = ctypes.create_string_buffer(cap * 2 * n)
    k = _lib.solve2(bytes(grid), n, cap, buf)
    if k >= cap:
        return None
    raw = buf.raw
    out = []
    for s in range(k):
        cells = ['.'] * (n * n)
        for r in range(n):
            cells[r * n + raw[s * 2 * n + 2 * r]] = 'x'
            cells[r * n + raw[s * 2 * n + 2 * r + 1]] = 'x'
        out.append(''.join(cells))
    return out


def solution_cells(grid, n, cap=4000):
    """like solutions2 but returns an int16 array (k, 2n) of star cell indices (row-major), or None if >= cap solutions exist"""
    import numpy as np
    buf = ctypes.create_string_buffer(cap * 2 * n)
    k = _lib.solve2(bytes(grid), n, cap, buf)
    if k >= cap:
        return None
    a = np.frombuffer(buf.raw, dtype=np.uint8, count=k * 2 * n).reshape(k, n, 2).astype(np.int16)
    return (a + (np.arange(n, dtype=np.int16) * n)[None, :, None]).reshape(k, 2 * n)


_lib.joint_solve.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_long]
_lib.joint_solve.restype = ctypes.c_int


def joint_solutions(grids, n, k, cap=2, node_limit=200_000_000):
    """Solutions common to every board in `grids` (each a flat list of region ids 0..n-1, k stars per row/col/region, no touching), up to
    `cap`. Returns a list of solution strings ('x'/'.', row-major), or None if the node limit ran out before the answer was settled."""
    assert len(grids) <= 4
    flat = b"".join(bytes(g) for g in grids)
    buf = ctypes.create_string_buffer(cap * n * k)
    got = _lib.joint_solve(flat, len(grids), n, k, cap, buf, node_limit)
    if got < 0:
        return None
    raw = buf.raw
    out = []
    for s in range(got):
        cells = ['.'] * (n * n)
        for r in range(n):
            for j in range(k):
                cells[r * n + raw[s * n * k + r * k + j]] = 'x'
        out.append(''.join(cells))
    return out


def solution_cells_k(grid, n, k, cap=4000, node_limit=200_000_000):
    """like solution_cells for any stars-per-unit k: int16 array (num_solutions, n*k) of star cell indices, or None if >= cap solutions / node limit hit"""
    import numpy as np
    buf = ctypes.create_string_buffer(cap * n * k)
    got = _lib.joint_solve(bytes(grid), 1, n, k, cap, buf, node_limit)
    if got < 0 or got >= cap:
        return None
    a = np.frombuffer(buf.raw, dtype=np.uint8, count=got * n * k).reshape(got, n, k).astype(np.int16)
    return (a + (np.arange(n, dtype=np.int16) * n)[None, :, None]).reshape(got, n * k)
