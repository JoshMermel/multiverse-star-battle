import random
from board_solver import get_all_solutions
from board_utils import get_neighbors_4, get_transformation_maps
from generator import Generator

class QuadAlignedGenerator(Generator):
    """
    Pre-generates a library of 4x4 'tiles' and stitches them together.
    """
    
    _tile_library = []

    def __init__(self, n, pool_size=600, stars_per_unit=1):
        super().__init__(n, stars_per_unit=stars_per_unit)
        if n != 8:
            raise ValueError("QuadPaster is currently optimized specifically for N=8.")
        
        # Build the library once per session
        if not self._tile_library:
            self._generate_tile_pool(pool_size)

    def _generate_tile_pool(self, size):
        """
        Generates 4x4 grids with exactly 2 regions, mixing balanced and imbalanced 
        layouts, and adds all 8 symmetric variants of each.
        """
        transformation_maps = get_transformation_maps(4)

        while len(self._tile_library) < size:
            tile = [None] * 16
            
            # 30% chance to generate an imbalanced tile
            if random.random() < 0.3:
                # --- Imbalanced Sequential Growth ---
                target_small_size = random.randint(2, 4)
                seed = random.randrange(16)
                tile[seed] = 0
                region_0 = [seed]
                
                # Grow Region 0 to the small target size
                while len(region_0) < target_small_size:
                    candidates = []
                    for cell in region_0:
                        for nb in get_neighbors_4(cell, 4):
                            if tile[nb] is None:
                                candidates.append(nb)
                    if not candidates: break
                    next_cell = random.choice(candidates)
                    tile[next_cell] = 0
                    region_0.append(next_cell)
                
                # Check if the remaining cells (Region 1) are contiguous
                unassigned = [i for i in range(16) if tile[i] is None]
                if unassigned:
                    # BFS to check connectivity of the remainder
                    start_node = unassigned[0]
                    visited = {start_node}
                    queue = [start_node]
                    while queue:
                        curr = queue.pop(0)
                        for nb in get_neighbors_4(curr, 4):
                            if tile[nb] is None and nb not in visited:
                                visited.add(nb)
                                queue.append(nb)
                    
                    # If the entire remainder is connected, it's a valid imbalanced tile
                    if len(visited) == len(unassigned):
                        for i in unassigned:
                            tile[i] = 1
                    else:
                        continue # Contiguity failed, retry
                else:
                    continue

            else:
                # --- Balanced Competitive Growth ---
                seeds = random.sample(range(16), 2)
                for i, s in enumerate(seeds):
                    tile[s] = i
                
                active = [0, 1]
                frontiers = [[seeds[0]], [seeds[1]]]
                
                while active:
                    random.shuffle(active)
                    for label in active[:]:
                        found = False
                        f = frontiers[label]
                        random.shuffle(f)
                        for cell in f:
                            neighbors = get_neighbors_4(cell, 4)
                            random.shuffle(neighbors)
                            for nb in neighbors:
                                if tile[nb] is None:
                                    tile[nb] = label
                                    f.append(nb)
                                    found = True
                                    break
                            if found: break
                        if not found:
                            active.remove(label)

            # --- Symmetry Expansion ---
            for forward_map, _ in transformation_maps:
                variant = [None] * 16
                for i, label in enumerate(tile):
                    variant[forward_map[i]] = label
                
                variant_tuple = tuple(variant)
                if variant_tuple not in self._tile_library:
                    self._tile_library.append(variant_tuple)
                    if len(self._tile_library) >= size:
                        break

    def _try_generate(self):
        tiles = random.sample(self._tile_library, 4)

        grid = [0] * 64
        for tile_idx, tile in enumerate(tiles):
            # Offset labels so Tile 0 is 0-1, Tile 1 is 2-3, etc.
            label_offset = tile_idx * 2
            
            # Calculate where this 4x4 sits in the 8x8
            # tile_idx: 0=TopLeft, 1=TopRight, 2=BottomLeft, 3=BottomRight
            row_off = 0 if tile_idx < 2 else 4
            col_off = 0 if tile_idx % 2 == 0 else 4
            
            for r in range(4):
                for c in range(4):
                    global_r = row_off + r
                    global_c = col_off + c
                    grid[global_r * 8 + global_c] = tile[r * 4 + c] + label_offset

        return self._make_result(grid)

if __name__ == "__main__":
    print("\n--- QuadAlignedGenerator (N=8) ---")
    QuadAlignedGenerator.demo(8)
