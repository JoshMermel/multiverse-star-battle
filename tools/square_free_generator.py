import random
from board_solver import get_all_solutions
from generator import Generator

class SquareFreeGenerator(Generator):
    """
    Generates Star Battle boards with 'skeletal' regions.
    
    Constraint: No cell is added to a region if it would create a 2x2 block
    of that same region or if it touches more than one existing cell of 
    the same region (enforcing strict branching).
    """

    def _try_generate(self):
        n = self.n
        grid_flat = [None] * (n * n)
        
        # 1. Initialize N seeds
        seed_indices = random.sample(range(n * n), n)
        frontiers = []
        for reg_id, idx in enumerate(seed_indices):
            grid_flat[idx] = reg_id
            frontiers.append([idx])

        active_regions = list(range(n))
        
        # 2. Competitive Branching Growth
        while active_regions:
            random.shuffle(active_regions)
            
            for reg_id in active_regions[:]:
                frontier = frontiers[reg_id]
                found_expansion = False
                
                # Search frontier backwards to prioritize 'tips' of branches
                for i in range(len(frontier) - 1, -1, -1):
                    curr_idx = frontier[i]
                    r, c = divmod(curr_idx, n)
                    
                    candidates = []
                    # Check 4-way cardinal neighbors
                    for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                        nr, nc = r + dr, c + dc
                        if 0 <= nr < n and 0 <= nc < n:
                            n_idx = nr * n + nc
                            
                            if grid_flat[n_idx] is None:
                                # Square-Free / Sparsity Check:
                                # Count neighbors of the target cell already belonging to reg_id
                                same_reg_count = 0
                                for ddr, ddc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                                    nnr, nnc = nr + ddr, nc + ddc
                                    if 0 <= nnr < n and 0 <= nnc < n:
                                        if grid_flat[nnr * n + nnc] == reg_id:
                                            same_reg_count += 1
                                
                                # Strict branching: must only connect to the parent cell
                                if same_reg_count == 1:
                                    candidates.append(n_idx)
                    
                    if candidates:
                        next_idx = random.choice(candidates)
                        grid_flat[next_idx] = reg_id
                        frontier.append(next_idx)
                        found_expansion = True
                        break
                    else:
                        # Dead end for this branch tip
                        frontier.pop(i)
                
                if not found_expansion:
                    active_regions.remove(reg_id)

        # 3. Validation and Solving
        solutions = get_all_solutions(grid_flat, n)
        return self._make_result(grid_flat, solutions)
