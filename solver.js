// solver.js
export class PuzzleSolver {
  constructor(game) {
    this.game = game;
    this.n = game.n;
  }

  // Move all your hint logic here
  getHint() {
    const rules = [
      this.hintCheckForErrors,
      this.hintExcludeRow,
      this.hintExcludeCol,
      this.hintExcludeAdjacency,
      this.hintOnlyEmpty,
      this.hintDomino
    ];

    for (let rule of rules) {
      const hint = rule.call(this);
      if (hint) return hint;
    }
    return null;
  }

  hintCheckForErrors() {
    const n = this.n;
    const highlights = [];
    let wrongStarCount = 0;
    let wrongDotCount = 0;

    // We must loop through the state stored in the game instance
    for (let i = 0; i < n * n; i++) {
      const userChoice = this.game.state[i]; // Point to this.game
      const correctChoice = this.game.solution[i]; // 'x' for star, '.' for dot

      // Check for misplaced stars
      if (userChoice === 'star' && correctChoice !== 'x') {
        highlights.push({ idx: i, color: 'hint-error-red' });
        wrongStarCount++;
      }

      // Check for dots that should be stars
      if (userChoice === 'dot' && correctChoice === 'x') {
        highlights.push({ idx: i, color: 'hint-error-red' });
        wrongDotCount++;
      }
    }

    if (highlights.length > 0) {
      // Construct a helpful message based on the counts
      let description = "Wait! You have some errors on the board: ";
      if (wrongStarCount > 0) description += `${wrongStarCount} misplaced star(s). `;
      if (wrongDotCount > 0) description += `${wrongDotCount} required star(s) marked as dots. `;
      description += "Check the red highlighted cells.";

      return {
        success: true,
        description: description,
        highlights: highlights,
        marks: [],
        boardIdx: undefined // Highlight across both boards
      };
    }

    return null;
  }

  getBlockedByStars(unitType) {
    const n = this.n;
    const units = this.getAllUnits().filter(u => u.label.includes(unitType));
    const marks = [];
    const highlights = [];

    units.forEach(unit => {
      const stars = unit.indices.filter(idx => this.game.state[idx] === 'star');

      // If this unit has a star, all other empty cells in it are blocked
      if (stars.length > 0) {
        unit.indices.forEach(idx => {
          if (this.game.state[idx] === 'none') {
            marks.push({ idx, color: 'hint-target-yellow' });
          }
        });
        stars.forEach(idx => highlights.push({ idx, color: 'hint-source-blue' }));
      }
    });

    return marks.length > 0 ? { marks, highlights } : null;
  }

  hintExcludeRow() {
    const result = this.getBlockedByStars("Row");
    if (!result) return null;

    return {
      success: true,
      description: "This row already has its star(s), so the remaining empty cells must be dots.",
      highlights: result.highlights,
      marks: result.marks,
      boardIdx: undefined // Rows affect both boards
    };
  }

  hintExcludeCol() {
    const result = this.getBlockedByStars("Column");
    if (!result) return null;

    return {
      success: true,
      description: "This column already has its star(s), so the remaining empty cells must be dots.",
      highlights: result.highlights,
      marks: result.marks,
      boardIdx: undefined // Columns affect both boards
    };
  }

  hintExcludeAdjacency() {
    const n = this.n;
    const marks = [];
    const highlights = [];

    for (let i = 0; i < n * n; i++) {
      if (this.game.state[i] === 'star') {
        highlights.push({ idx: i, color: 'hint-source-blue' });
        const r = Math.floor(i / n);
        const c = i % n;

        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
              const neighborIdx = nr * n + nc;
              if (this.game.state[neighborIdx] === 'none') {
                marks.push({ idx: neighborIdx, color: 'hint-target-yellow' });
              }
            }
          }
        }
      }
    }

    if (marks.length > 0) {
      return {
        success: true,
        description: "Stars cannot touch each other, even diagonally. Blocking neighboring cells.",
        highlights,
        marks,
        boardIdx: undefined
      };
    }
    return null;
  }

  hintOnlyEmpty() {
    const units = this.getAllUnits();

    for (const unit of units) {
      const hasStar = unit.indices.some(i => this.game.state[i] === 'star'); 
      if (hasStar) continue;

      const empty = unit.indices.filter(i => this.game.state[i] === 'none');

      if (empty.length === 1) {
        const targetIdx = empty[0];
        const restOfUnit = unit.indices.filter(i => i !== targetIdx);

        return {
          success: true,
          description: `In ${unit.label}, all other squares are blocked, leaving only one spot left for a star.`,
          highlights: [{ idx: targetIdx, color: 'hint-source-blue' }],
          marks: restOfUnit.map(idx => ({ idx, color: 'hint-target-yellow' })),
          boardIdx: unit.boardIdx 
        };
      }
    }
    return null;
  }

  hintDomino() {
    const n = this.n;
    const units = this.getAllUnits();

    const regions = units.filter(u => u.boardIdx !== undefined);

    for (const region of regions) {
      if (region.indices.some(i => this.game.state[i] === 'star')) continue;

      const empty = region.indices.filter(i => this.game.state[i] === 'none');
      if (empty.length !== 2) continue;

      const [idxA, idxB] = empty;
      const rA = Math.floor(idxA / n), cA = idxA % n;
      const rB = Math.floor(idxB / n), cB = idxB % n;

      let blockedIndices = new Set();
      let reason = "";

      // Case A: Shared Row
      if (rA === rB) {
        for (let k = 0; k < n; k++) blockedIndices.add(rA * n + k);
        reason = "row";
      } 
      // Case B: Shared Column
      else if (cA === cB) {
        for (let k = 0; k < n; k++) blockedIndices.add(k * n + cA);
        reason = "column";
      }

      // Always add the 8-way neighborhood intersection (King's move)
      const getAdj = (idx) => {
        const neighbors = new Set();
        const r = Math.floor(idx / n), c = idx % n;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < n && nc >= 0 && nc < n) neighbors.add(nr * n + nc);
          }
        }
        return neighbors;
      };

      const adjA = getAdj(idxA);
      const adjB = getAdj(idxB);

      [...adjA].forEach(idx => {
        if (adjB.has(idx)) blockedIndices.add(idx);
      });

      // Clean up
      blockedIndices.delete(idxA);
      blockedIndices.delete(idxB);

      const targets = Array.from(blockedIndices).filter(idx => this.game.state[idx] === 'none');

      if (targets.length > 0) {
        return {
          success: true,
          description: `Since a star must be in one of these two cells in ${region.label}, the rest of their shared ${reason || 'neighborhood'} can be marked with dots.`,
          highlights: [
            { idx: idxA, color: 'hint-source-blue' },
            { idx: idxB, color: 'hint-source-blue' }
          ],
          marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' })),
          boardIdx: region.boardIdx 
        };
      }
    }
    return null;
  }

  getAllUnits() {
    const n = this.n;
    const units = [];

    // 1. Rows (Shared)
    for (let r = 0; r < n; r++) {
      const indices = Array.from({ length: n }, (_, k) => r * n + k);
      units.push({ indices, label: `Row ${r + 1}` });
    }

    // 2. Columns (Shared)
    for (let c = 0; c < n; c++) {
      const indices = Array.from({ length: n }, (_, k) => k * n + c);
      units.push({ indices, label: `Column ${String.fromCharCode(65 + c)}` });
    }

    if (!this.game.regions) {
      console.error("Regions data is missing from the game instance!");
      return units;
    }

    this.game.regions.forEach((regionString, boardIdx) => {
      const regionIds = [...new Set(regionString.split(''))];
      regionIds.forEach(id => {
        const indices = [];
        for (let j = 0; j < regionString.length; j++) {
          if (regionString[j] === id) indices.push(j);
        }
        units.push({ 
          indices, 
          label: `Board ${boardIdx + 1} Region ${id}`,
          boardIdx: boardIdx 
        });
      });
    });

    return units;
  }
}
