/* fast_solve.c -- enumerate (up to cap) 2-star placements of an NxN multi-region board.
   int solve2(const unsigned char *grid, int n, int cap, unsigned char *out)
   grid[r*n+c] = region id (0..n-1). Returns the number of solutions found (<= cap); each solution is n rows * 2 bytes (c1,c2) in out.
   Rules: exactly 2 stars per row, column and region; no two stars touching (incl. diagonally). */
#include <string.h>
#define MAXN 16
static int N, CAP, found;
static const unsigned char *G;
static unsigned char *OUT;
static int colcnt[MAXN], regcnt[MAXN];
static int pick[MAXN][2];
static int regleft[MAXN + 1][MAXN];   /* regleft[r][g] = cells of region g in rows >= r */

static void rec(int r) {
    if (found >= CAP) return;
    if (r == N) {
        for (int i = 0; i < N; i++) { OUT[found * 2 * N + 2 * i] = pick[i][0]; OUT[found * 2 * N + 2 * i + 1] = pick[i][1]; }
        found++;
        return;
    }
    int rem = N - r;                       /* rows left including this one */
    for (int c = 0; c < N; c++) {          /* column feasibility: a column gets at most one star per two rows */
        if (colcnt[c] > 2) return;
        if (2 - colcnt[c] > (rem + 1) / 2) return;
    }
    for (int g = 0; g < N; g++)
        if (2 - regcnt[g] > regleft[r][g]) return;
    for (int a = 0; a < N; a++) {
        if (colcnt[a] >= 2) continue;
        if (r > 0 && (a >= pick[r-1][0] - 1 && a <= pick[r-1][0] + 1)) continue;
        if (r > 0 && (a >= pick[r-1][1] - 1 && a <= pick[r-1][1] + 1)) continue;
        int ga = G[r * N + a];
        if (regcnt[ga] >= 2) continue;
        colcnt[a]++; regcnt[ga]++;
        for (int b = a + 2; b < N; b++) {
            if (colcnt[b] >= 2) continue;
            if (r > 0 && (b >= pick[r-1][0] - 1 && b <= pick[r-1][0] + 1)) continue;
            if (r > 0 && (b >= pick[r-1][1] - 1 && b <= pick[r-1][1] + 1)) continue;
            int gb = G[r * N + b];
            if (regcnt[gb] >= 2) continue;
            colcnt[b]++; regcnt[gb]++;
            pick[r][0] = a; pick[r][1] = b;
            rec(r + 1);
            colcnt[b]--; regcnt[gb]--;
            if (found >= CAP) break;
        }
        colcnt[a]--; regcnt[ga]--;
        if (found >= CAP) return;
    }
}

int solve2(const unsigned char *grid, int n, int cap, unsigned char *out) {
    N = n; CAP = cap; found = 0; G = grid; OUT = out;
    memset(colcnt, 0, sizeof colcnt); memset(regcnt, 0, sizeof regcnt);
    memset(regleft, 0, sizeof regleft);
    for (int r = n - 1; r >= 0; r--) {
        for (int g = 0; g < n; g++) regleft[r][g] = regleft[r + 1][g];
        for (int c = 0; c < n; c++) regleft[r][grid[r * n + c]]++;
    }
    rec(0);
    return found;
}
