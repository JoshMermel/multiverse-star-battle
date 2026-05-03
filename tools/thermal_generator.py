# experimental suggestion from gemini
# I'm unsure if these puzzles feel any different from random ones, and am curous
# to explore.

import random
import heapq
from board_utils import ALPHABET
from generator import Generator
from board_solver import get_all_solutions

class ThermalGenerator(Generator):
    """
    Generates regions using a 'heat' expansion model with tunable noise.
    
    Parameters:
    - noise_level: float between 0 and 1. 
      0 = Pure Voronoi (straight lines).
      1 = Maximum jaggedness (chaotic boundaries).
    """

    def __init__(self, n, noise_level=0.5):
        super().__init__(n)
        self.noise_level = max(0.0, min(1.0, noise_level))

    def _try_generate(self):
        n = self.n
        grid = [-1] * (n * n)
        
        # 1. Seed points
        seeds = random.sample(range(n * n), n)
        
        # 2. Define weight range based on noise_level.
        # At noise_level 0, all weights are 1.0 (Uniform expansion).
        # At noise_level 1, weights vary wildly from 1.0 to 100.0.
        max_weight = 1.0 + (self.noise_level * 99.0)
        weights = [random.uniform(1.0, max_weight) for _ in range(n * n)]
        
        # 3. Dijkstra-based expansion
        pq = []
        for reg_id, seed_idx in enumerate(seeds):
            grid[seed_idx] = reg_id
            heapq.heappush(pq, (0, seed_idx, reg_id))

        while pq:
            cost, u_idx, reg_id = heapq.heappop(pq)
            
            r, c = divmod(u_idx, n)
            for dr, dc in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
                nr, nc = r + dr, c + dc
                if 0 <= nr < n and 0 <= nc < n:
                    v_idx = nr * n + nc
                    if grid[v_idx] == -1:
                        grid[v_idx] = reg_id
                        # Add the cell's unique weight to the path cost
                        new_cost = cost + weights[v_idx] 
                        heapq.heappush(pq, (new_cost, v_idx, reg_id))

        # 4. Standard validation and formatting
        solutions = get_all_solutions(grid, n)
        return self._make_result(grid, solutions)
