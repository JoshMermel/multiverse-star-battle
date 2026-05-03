"""
voting_district_generator.py

Generates Star Battle boards where every region contains exactly N cells,
inspired by the ReCom (Recombination) algorithm used in political redistricting
research.  See Deford, Duchin & Solomon (2019), "Recombination: A family of
Markov chains for redistricting", https://arxiv.org/abs/1911.05725.

Method
------
1. Seed with a striped partition: region k gets all cells in row k, giving N
   contiguous regions of exactly N cells each.
2. Repeatedly pick two adjacent regions, merge them into a 2N-cell blob, build
   a random spanning tree of that blob using Wilson's loop-erased random walk,
   and cut a "balance edge" — one whose removal yields two subtrees of size N.
   If no balance edge exists for this spanning tree, retry with a fresh tree
   (up to a small limit).
3. After enough accepted moves the board is well-shuffled; solve and return.

Note: each generation attempt is expensive (4·N² ReCom moves). If calling
generate() directly, consider passing a low max_attempts (e.g. 5-10) rather
than the default 1000.
"""

from collections import deque
import random

from board_solver import get_all_solutions
from board_utils import get_neighbors_4, pretty_print
from generator import Generator

# Max spanning-tree retries per region pair before skipping that pair.
_SPANNING_TREE_ATTEMPTS = 10


class VotingDistrictGenerator(Generator):
    """Generates a board where every region contains exactly N cells."""

    def __init__(self, n):
        super().__init__(n)
        self._moves_per_attempt = 4 * n * n
        # Precompute the full grid adjacency list — it never changes between moves.
        self._grid_adj = {idx: get_neighbors_4(idx, n) for idx in range(n * n)}

    # ── grid helpers ──────────────────────────────────────────────────────────

    def _region_adjacency(self, grid):
        """
        Returns a set of frozensets {a, b} for every pair of distinct
        neighbouring regions in grid.
        """
        adj = set()
        for idx in range(self.n * self.n):
            for nb in self._grid_adj[idx]:
                a, b = grid[idx], grid[nb]
                if a != b:
                    adj.add(frozenset((a, b)))
        return adj

    # ── spanning-tree helpers ─────────────────────────────────────────────────

    @staticmethod
    def _random_spanning_tree(blob_list, blob_adj):
        """
        Builds a random spanning tree of the induced subgraph on the blob
        using Wilson's loop-erased random walk algorithm.
        Returns the tree as an adjacency dict {cell: [neighbour, ...]}.

        blob_list -- list of cell indices (for random selection and iteration)
        blob_adj  -- adjacency dict restricted to within the blob
        """
        in_tree = set()
        tree_adj = {c: [] for c in blob_list}

        root = random.choice(blob_list)
        in_tree.add(root)

        for start in blob_list:
            if start in in_tree:
                continue
            path = [start]
            visited_in_walk = {start: 0}
            cur = start
            while cur not in in_tree:
                nbrs = blob_adj.get(cur, [])
                if not nbrs:
                    # Isolated node in blob subgraph — blob is malformed.
                    return None
                nxt = random.choice(nbrs)
                if nxt in visited_in_walk:
                    path = path[:visited_in_walk[nxt] + 1]
                    visited_in_walk = {c: i for i, c in enumerate(path)}
                else:
                    visited_in_walk[nxt] = len(path)
                    path.append(nxt)
                cur = nxt

            for i in range(len(path) - 1):
                a, b = path[i], path[i + 1]
                tree_adj[a].append(b)
                tree_adj[b].append(a)
                in_tree.add(a)
            in_tree.add(cur)

        return tree_adj

    @staticmethod
    def _find_balance_edges(tree_adj, blob):
        """
        Returns a list of (child, parent) edges in the spanning tree whose
        removal produces two subtrees of equal size (len(blob) // 2 each).
        Uses a single DFS to compute subtree sizes.
        """
        n_half = len(blob) // 2
        root = next(iter(blob))
        parent = {root: None}
        order = []
        stack = [root]
        visited = {root}
        while stack:
            node = stack.pop()
            order.append(node)
            for nb in tree_adj.get(node, []):
                if nb not in visited:
                    visited.add(nb)
                    parent[nb] = node
                    stack.append(nb)

        subtree_size = {c: 1 for c in blob}
        for node in reversed(order):
            p = parent[node]
            if p is not None:
                subtree_size[p] += subtree_size[node]

        return [
            (node, parent[node])
            for node in blob
            if parent[node] is not None and subtree_size[node] == n_half
        ]

    # ── ReCom move ────────────────────────────────────────────────────────────

    def _update_adjacency(self, adj, region_cells, cell_to_region, ra, rb):
        """
        Incrementally updates the adjacency set after a move that reshaped
        regions ra and rb.  Only edges touching ra or rb can have changed, so
        we recheck just the boundary cells of those two regions rather than
        rescanning the whole grid.
        """
        adj.discard(frozenset((ra, rb)))
        stale = {pair for pair in adj if ra in pair or rb in pair}
        adj -= stale

        for region_id in (ra, rb):
            for cell in region_cells[region_id]:
                for nb in self._grid_adj[cell]:
                    nb_region = cell_to_region[nb]
                    if nb_region != region_id:
                        adj.add(frozenset((region_id, nb_region)))

    def _recom_move(self, grid, region_cells, cell_to_region, adj):
        """
        Attempts one ReCom move on grid in-place.
        Picks a random adjacent region pair, merges them, builds a random
        spanning tree, and cuts a balance edge.  Returns True on success.
        grid, region_cells, cell_to_region, and adj are all updated in-place
        on success.

        The inner `for/else` retries the spanning tree up to
        _SPANNING_TREE_ATTEMPTS times for a given pair: the `else` branch runs
        only if the loop exhausted all retries without finding balance edges,
        in which case `continue` skips to the next region pair.
        """
        adj_list = list(adj)
        random.shuffle(adj_list)

        for pair in adj_list:
            ra, rb = tuple(pair)
            blob = region_cells[ra] | region_cells[rb]
            blob_list = list(blob)
            blob_adj = {c: [nb for nb in self._grid_adj[c] if nb in blob]
                        for c in blob_list}

            for _ in range(_SPANNING_TREE_ATTEMPTS):
                tree = self._random_spanning_tree(blob_list, blob_adj)
                if tree is None:
                    break
                balance_edges = self._find_balance_edges(tree, blob)
                if balance_edges:
                    break
            else:
                continue

            cut_u, cut_v = random.choice(balance_edges)
            cut_edge = frozenset((cut_u, cut_v))

            new_ra = set()
            q = deque([cut_u])
            while q:
                node = q.popleft()
                if node in new_ra:
                    continue
                new_ra.add(node)
                for nb in tree.get(node, []):
                    if nb not in new_ra and frozenset((node, nb)) != cut_edge:
                        q.append(nb)
            new_rb = blob - new_ra

            for cell in new_ra:
                grid[cell] = ra
                cell_to_region[cell] = ra
            for cell in new_rb:
                grid[cell] = rb
                cell_to_region[cell] = rb
            region_cells[ra] = new_ra
            region_cells[rb] = new_rb

            self._update_adjacency(adj, region_cells, cell_to_region, ra, rb)
            return True

        return False

    # ── main generate ─────────────────────────────────────────────────────────

    def _try_generate(self):
        """
        One attempt at generating a board where every region has exactly N
        cells.  Returns (flat_board_string, solution_set) on success, or None
        on failure.  The outer retry loop in Generator.generate() handles
        repeated attempts.
        """
        n = self.n

        # Striped initial partition: region r owns all cells in row r.
        grid = [r for r in range(n) for _ in range(n)]
        region_cells = {r: set(range(r * n, (r + 1) * n)) for r in range(n)}
        # Use a list for O(1) index access since cell indices are contiguous ints.
        cell_to_region = [0] * (n * n)
        for r, cells in region_cells.items():
            for cell in cells:
                cell_to_region[cell] = r

        adj = self._region_adjacency(grid)

        moves_done = 0
        for _ in range(self._moves_per_attempt):
            if self._recom_move(grid, region_cells, cell_to_region, adj):
                moves_done += 1

        # If no moves succeeded the board is effectively unshuffled; skip it.
        if moves_done == 0:
            return None

        solutions = get_all_solutions(grid, n)
        return self._make_result(grid, solutions)


if __name__ == "__main__":
    print("\n--- Voting District Generator (N=8) ---")
    gen = VotingDistrictGenerator(8)
    board, solutions = gen.generate(max_attempts=10)
    pretty_print(board, 8)
    print(f"Solutions: {len(solutions)}")
