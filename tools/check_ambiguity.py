import csv
import sys
from itertools import combinations

# Ensure board_solver/board_utils can be imported.
# If this script is outside the project folder, add its location to sys.path
try:
    from board_solver import get_solutions_capped_multi
    from board_utils import ALPHABET, VOID_CHAR, board_columns
except ImportError:
    print("Error: Could not import 'board_solver'. Please ensure this script "
          "is placed in the same directory as board_solver.py or that it is in your Python path.")
    sys.path.append(".")
    from board_solver import get_solutions_capped_multi
    from board_utils import ALPHABET, VOID_CHAR, board_columns


def decode_board_string(board_str):
    """
    Converts a flat alphabet/character board string into the grid
    representation board_solver expects: each region character maps to its
    ALPHABET index ('A' -> 0, 'B' -> 1, ...; also covers lowercase), while
    VOID_CHAR cells are left as VOID_CHAR rather than decoded, since
    board_solver identifies void cells by comparing against that literal
    string. Decoding a void cell into an int would instead turn it into its
    own singleton region that CP-SAT forces to always hold a star.
    """
    return [VOID_CHAR if char == VOID_CHAR else ALPHABET.index(char) for char in board_str]


def does_violates_subset_ambiguity(row):
    """
    Returns True if the puzzle violates the property (i.e., there exists a 
    subset of size M-1 that is NOT ambiguous / uniquely solvable).
    """
    n = int(row['N'])

    # Extract all active board strings (ignoring empty or missing columns)
    board_keys = board_columns(row.keys())
    raw_boards = [row[k] for k in board_keys if row[k].strip()]
    
    m = len(raw_boards)
    if m < 2:
        # With fewer than 2 boards there's no smaller subset to check against,
        # so the "requires all M boards" property is vacuously satisfied.
        return False
        
    # Convert flat strings to the flat integer array expected by board_solver
    grids = [decode_board_string(b) for b in raw_boards]
    
    # Check every subset of size M - 1
    for subset in combinations(grids, m - 1):
        # Pass the subset to CP-SAT. Cap at 2 since we only need to know 
        # if solutions <= 1 (unique/unsolvable) vs solutions >= 2 (ambiguous).
        joint_solutions = get_solutions_capped_multi(list(subset), n, cap=2)
        
        # If a subset yields 1 or 0 solutions, it means this sub-combination 
        # is enough to pin down a unique state. Thus, it fails the "strictly 
        # requires all M boards" property.
        if len(joint_solutions) <= 1:
            return True
            
    return False


def verify_csv_subset_ambiguity(csv_path):
    print(f"Reading and analyzing puzzles from: {csv_path}...\n")
    
    invalid_count = 0
    total_processed = 0
    
    try:
        with open(csv_path, mode='r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            
            # Simple validation on expected column structure
            required_cols = {'N', 'board_1', 'board_2'}
            if not required_cols.issubset(reader.fieldnames or []):
                print(f"Error: CSV missing required columns. Found fields: {reader.fieldnames}")
                return

            for row in reader:
                total_processed += 1
                name = row.get('name', f"Row #{total_processed}")
                
                # Perform CP-SAT intersection check on sub-combinations
                if does_violates_subset_ambiguity(row):
                    invalid_count += 1
                    print(f" Found Violation: Puzzle '{name}' (N={row['N']}) can be uniquely solved without all boards.")
                
                if total_processed % 10 == 0:
                    print(f" Progress: Processed {total_processed} puzzles...")

    except FileNotFoundError:
        print(f"Error: File not found at '{csv_path}'")
        return
    
    print("\n" + "="*40)
    print(f"Analysis Complete.")
    print(f"Total Puzzles Processed: {total_processed}")
    print(f"Puzzles violating M-1 ambiguity: {invalid_count}")
    print("="*40)


if __name__ == "__main__":
    # Default input file; override via a command-line argument (see below).
    target_csv = "puzzles.csv"
    
    if len(sys.argv) > 1:
        target_csv = sys.argv[1]
        
    verify_csv_subset_ambiguity(target_csv)
