"""
capture_armory2_screenshots.py

Uses Playwright (headless Chromium) to automate the actual live app: for
each armory2 puzzle, clears saved progress, replays the exact pre-hint
moves (from armory2_setup.json), clicks Hint, dismisses the hint TEXT toast
(clicking it, matching the real dismiss affordance) while keeping the
board highlights, and saves a screenshot of just the #boards-wrapper
element -- cropped tightly, at real resolution, no manual pixel math.

Requires a static file server already running (see .claude/launch.json)
serving the repo root.

Usage:
    python3 capture_armory2_screenshots.py <base_url> <setup_json> <out_dir>
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright


def capture_one(page, base_url, slug, moves, out_dir):
    url = f"{base_url}/index.html?book=armory2&puzzle={slug['puzzle_num']}"
    page.goto(url)
    page.wait_for_timeout(300)
    # Wipe any saved progress for a guaranteed-clean slate.
    page.evaluate("""
        Object.keys(localStorage).filter(k => k.startsWith('sb_v2_state_'))
              .forEach(k => localStorage.removeItem(k));
    """)
    page.reload()
    page.wait_for_timeout(300)

    # Axis labels on (once is enough, but idempotent -- cheap to redo per puzzle
    # since we just wiped localStorage, which also holds this setting... actually
    # setting-axis-labels is a separate key, not sb_v2_state_*, so it survives).
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

    # Dismiss the toast TEXT (clicking it, same as a real user would) while
    # keeping the highlight classes on the board -- matches "highlights
    # present, hint text not" from the spec. Toast ignores clicks within
    # 500ms of birth, so wait past that first.
    page.wait_for_timeout(600)
    page.evaluate("document.getElementById('toast')?.click()")
    page.wait_for_timeout(200)

    out_path = f"{out_dir}/{slug['image_name']}.png"
    page.locator('#boards-wrapper').screenshot(path=out_path)

    return {'slug': slug['slug'], 'banner_text': banner_text, 'err_count': err_count, 'out_path': out_path}


def main():
    base_url = sys.argv[1]
    setup_path = sys.argv[2]
    out_dir = sys.argv[3]
    roster_path = sys.argv[4]

    setup = json.load(open(setup_path))
    roster = json.load(open(roster_path))
    puzzle_num_by_slug = {r['slug']: i + 1 for i, r in enumerate(roster)}

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1100, 'height': 1000})

        results = []
        for slug_name, data in setup.items():
            slug = {
                'slug': slug_name,
                'puzzle_num': puzzle_num_by_slug[slug_name],
                'image_name': f"multi_{slug_name}",
            }
            result = capture_one(page, base_url, slug, data['pre'], out_dir)
            print(f"{slug_name}: banner='{result['banner_text']}' errors={result['err_count']} -> {result['out_path']}", flush=True)
            results.append(result)

        browser.close()

    bad = [r for r in results if r['err_count'] > 0]
    if bad:
        print(f"\nWARNING: {len(bad)} puzzles had visible errors: {[r['slug'] for r in bad]}")
    print(f"\nCaptured {len(results)} screenshots -> {out_dir}")


if __name__ == "__main__":
    main()
