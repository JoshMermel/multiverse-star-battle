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

/* ---- joint solver: any stars-per-unit K, several boards at once, stops after `cap` common solutions ---- */
#define MAXB 4
static int JN, JK, JNB, JCAP, jfound;
static long jnodes, jlimit;
static int jabort;
static const unsigned char *JG;           /* JG[(b*N + r)*N + c] */
static unsigned char *JOUT;
static int jcol[MAXN], jreg[MAXB][MAXN], jpick[MAXN][MAXN];
static int jleft[MAXB][MAXN + 1][MAXN];

static void jrow(int r);

static void jpickcols(int r, int c0, int j) {
    if (jfound >= JCAP || jabort) return;
    if (++jnodes > jlimit) { jabort = 1; return; }
    if (j == JK) { jrow(r + 1); return; }
    int lastc = JN - 1 - 2 * (JK - j - 1);
    for (int c = c0; c <= lastc; c++) {
        if (jcol[c] >= JK) continue;
        if (r > 0) {
            int bad = 0;
            for (int i = 0; i < JK; i++) { int d = jpick[r-1][i] - c; if (d >= -1 && d <= 1) { bad = 1; break; } }
            if (bad) continue;
        }
        int ok = 1;
        for (int b = 0; b < JNB; b++) if (jreg[b][JG[(b * JN + r) * JN + c]] >= JK) { ok = 0; break; }
        if (!ok) continue;
        jcol[c]++;
        for (int b = 0; b < JNB; b++) jreg[b][JG[(b * JN + r) * JN + c]]++;
        jpick[r][j] = c;
        jpickcols(r, c + 2, j + 1);
        jcol[c]--;
        for (int b = 0; b < JNB; b++) jreg[b][JG[(b * JN + r) * JN + c]]--;
        if (jfound >= JCAP || jabort) return;
    }
}

static void jrow(int r) {
    if (r == JN) {
        for (int i = 0; i < JN; i++) for (int j = 0; j < JK; j++) JOUT[jfound * JN * JK + i * JK + j] = jpick[i][j];
        jfound++;
        return;
    }
    int rem = JN - r;
    for (int c = 0; c < JN; c++) if (JK - jcol[c] > (rem + 1) / 2) return;
    for (int b = 0; b < JNB; b++)
        for (int g = 0; g < JN; g++) if (JK - jreg[b][g] > jleft[b][r][g]) return;
    jpickcols(r, 0, 0);
}

/* returns number of common solutions found (<= cap), or -1 if the node limit was exceeded before reaching cap */
int joint_solve(const unsigned char *grids, int nb, int n, int k, int cap, unsigned char *out, long node_limit) {
    JN = n; JK = k; JNB = nb; JCAP = cap; jfound = 0; jnodes = 0; jlimit = node_limit; jabort = 0; JG = grids; JOUT = out;
    memset(jcol, 0, sizeof jcol); memset(jreg, 0, sizeof jreg); memset(jleft, 0, sizeof jleft);
    for (int b = 0; b < nb; b++)
        for (int r = n - 1; r >= 0; r--) {
            for (int g = 0; g < n; g++) jleft[b][r][g] = jleft[b][r + 1][g];
            for (int c = 0; c < n; c++) jleft[b][r][grids[(b * n + r) * n + c]]++;
        }
    jrow(0);
    if (jabort && jfound < cap) return -1;
    return jfound;
}
