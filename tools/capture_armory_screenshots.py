"""
capture_armory_screenshots.py

Generalized version of capture_armory2_screenshots.py: works against any
book (armory or armory2). Uses Playwright (headless Chromium) to automate
the actual live app: for each puzzle, clears saved progress, replays the
exact pre-hint moves, clicks Hint, dismisses the hint TEXT toast (clicking
it, matching the real dismiss affordance) while keeping the board
highlights, and saves a screenshot of just the #boards-wrapper element --
cropped tightly, at real resolution, no manual pixel math.

Requires a static file server already running (see .claude/launch.json)
serving the repo root.

Usage:
    python3 capture_armory_screenshots.py <base_url> <book> <setup_json> <out_dir> <puzzle_nums_json>

<puzzle_nums_json> maps slug -> puzzle number (1-indexed CSV row), e.g.
{"tile_domino": 29, ...}. <setup_json> maps slug -> {"pre": [[idx,'star'|'dot'], ...]}.
Screenshots are saved as <out_dir>/<slug>.png (no prefix -- caller renames/
copies as needed).
"""
import json
import sys
from playwright.sync_api import sync_playwright


def capture_one(page, base_url, book, puzzle_num, moves, out_path):
    url = f"{base_url}/index.html?book={book}&puzzle={puzzle_num}"
    page.goto(url)
    page.wait_for_timeout(300)
    page.evaluate("""
        Object.keys(localStorage).filter(k => k.startsWith('sb_v2_state_'))
              .forEach(k => localStorage.removeItem(k));
    """)
    page.reload()
    page.wait_for_timeout(300)

    page.evaluate("localStorage.setItem('setting-axis-labels', 'true'); location.reload();")
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(300)

    move_js = json.dumps(moves)
    page.evaluate(f"""
        (() => {{
            function setCell(dataIndex, kind) {{
                const cell = document.querySelector(`.cell[data-index="${{dataIndex}}"]`);
                const button = kind === 'star' ? 2 : 0;
                const down = new PointerEvent('pointerdown', {{bubbles: true, cancelable: true, button, pointerId: 1, isPrimary: true}});
                cell.dispatchEvent(down);
                const up = new PointerEvent('pointerup', {{bubbles: true, cancelable: true, button, pointerId: 1, isPrimary: true}});
                window.dispatchEvent(up);
            }}
            const moves = {move_js};
            for (const [idx, kind] of moves) setCell(idx, kind);
        }})();
    """)
    page.wait_for_timeout(200)

    page.click('#hint-btn')
    page.wait_for_timeout(200)

    banner_text = page.evaluate("document.querySelector('[class*=\"toast\"]')?.textContent || null")
    err_count = page.evaluate("[...document.querySelectorAll('.cell')].filter(c=>c.className.includes('error')).length")

    page.wait_for_timeout(600)
    page.evaluate("document.getElementById('toast')?.click()")
    page.wait_for_timeout(200)

    page.locator('#boards-wrapper').screenshot(path=out_path)
    return {'banner_text': banner_text, 'err_count': err_count}


def main():
    base_url = sys.argv[1]
    book = sys.argv[2]
    setup_path = sys.argv[3]
    out_dir = sys.argv[4]
    puzzle_nums_path = sys.argv[5]

    setup = json.load(open(setup_path))
    puzzle_nums = json.load(open(puzzle_nums_path))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1100, 'height': 1000})

        results = []
        for slug, data in setup.items():
            out_path = f"{out_dir}/{slug}.png"
            result = capture_one(page, base_url, book, puzzle_nums[slug], data['pre'], out_path)
            print(f"{slug}: banner='{result['banner_text']}' errors={result['err_count']} -> {out_path}", flush=True)
            results.append({'slug': slug, **result})

        browser.close()

    bad = [r for r in results if r['err_count'] > 0]
    if bad:
        print(f"\nWARNING: {len(bad)} puzzles had visible errors: {[r['slug'] for r in bad]}")
    print(f"\nCaptured {len(results)} screenshots -> {out_dir}")


if __name__ == "__main__":
    main()
