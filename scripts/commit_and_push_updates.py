"""Commit the reviewed local update in six logical groups, then push main.

Preview: python3 scripts/commit_and_push_updates.py
Execute: python3 scripts/commit_and_push_updates.py --execute
Uses existing Git identity, ordinary commits and a normal (never forced) push.
"""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REMOTE = 'https://github.com/siddhm11/prompt_engineering_skeleton.git'
GROUPS = [
    ('Stop logging prompt and conversation content', [
        'backend/routers/prompts.py',
    ]),
    ('Make account deletion retryable and verify dependent data cleanup', [
        'backend/routers/users.py', 'backend/services/memory_service.py',
        'tests/test_account_deletion_contract.py', 'tests/test_api_integration.py',
        'tests/test_saved_prompt_vectors.py',
    ]),
    ('Improve extension consent, setup and accessible rewrite controls', [
        'extension/background.js', 'extension/content.js', 'extension/manifest.json',
        'extension/popup.html', 'extension/popup.js', 'extension/styles.css',
        'extension/tests/pill-harness.html', 'tests/test_extension_static.py',
        'tests/extension_ui_runtime.js', 'scripts/test_extension_ui_runtime.py',
    ]),
    ('Clarify website installation and improve navigation and accessibility', [
        'website/index.html', 'website/main.js', 'website/privacy.html', 'website/styles.css',
    ]),
    ('Add reproducible extension packaging and grouped release commit tooling', [
        'scripts/package_extension.py', 'scripts/commit_and_push_updates.py',
    ]),
    ('Document release setup, UX findings and verification limits', [
        'README.md', 'docs/CHROME_WEB_STORE_SUBMISSION.md',
        'docs/UI_UX_RESEARCH_AND_ROADMAP.md', 'docs/UI_UX_FIXES_4_4.md',
    ]),
]


def run(*args, capture=False):
    result = subprocess.run(args, cwd=ROOT, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', help='create commits and push origin/main')
    args = parser.parse_args()
    for i, (message, files) in enumerate(GROUPS, 1):
        print(f'{i}. {message}\n   ' + ', '.join(files), flush=True)
    if not args.execute:
        print('\nPreview only. Pass --execute to validate, commit, and push.')
        return

    if run('git', 'branch', '--show-current', capture=True) != 'main':
        raise RuntimeError('Expected branch main. No changes committed.')
    if run('git', 'remote', 'get-url', 'origin', capture=True) != REMOTE:
        raise RuntimeError('Origin differs from the reviewed GitHub repository.')
    if run('git', 'remote', 'get-url', '--push', 'origin', capture=True) != REMOTE:
        raise RuntimeError('Push URL differs from the reviewed GitHub repository.')
    allowed = {path for _, files in GROUPS for path in files}
    staged = set(run('git', 'diff', '--cached', '--name-only', capture=True).splitlines())
    if staged - allowed:
        raise RuntimeError('Unrelated staged files found; preserve/review them before running this script.')
    for marker in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'):
        path = Path(run('git', 'rev-parse', '--git-path', marker, capture=True))
        if not path.is_absolute():
            path = ROOT / path
        if path.exists():
            raise RuntimeError('Finish the current merge/rebase/cherry-pick first.')
    run('git', 'diff', '--check')
    run('git', 'diff', '--cached', '--check')
    run(sys.executable, 'scripts/test_extension_ui_runtime.py')
    run(sys.executable, 'tests/test_account_deletion_contract.py')
    run('git', 'fetch', 'origin')
    ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'], cwd=ROOT)
    if ancestor.returncode != 0:
        raise RuntimeError('origin/main has changes not in local HEAD. Reconcile them before committing; no automatic rebase will run.')

    hashes = []
    for message, files in GROUPS:
        changed = run('git', 'status', '--porcelain', '--', *files, capture=True)
        if not changed:
            print('Already clean; skipping:', message, flush=True)
            continue
        run('git', 'add', '--', *files)
        # --only prevents other staged groups from leaking into this commit.
        run('git', 'commit', '--only', '-m', message, '--', *files)
        hashes.append(run('git', 'rev-parse', '--short', 'HEAD', capture=True))
    run('git', 'push', 'origin', 'main')
    local = run('git', 'rev-parse', 'HEAD', capture=True)
    published = run('git', 'ls-remote', '--heads', 'origin', 'main', capture=True).split()
    if not published or published[0] != local:
        raise RuntimeError('Push returned, but remote HEAD verification did not match. Inspect GitHub before retrying.')
    print(f'Created {len(hashes)} commits: {", ".join(hashes) or "none (already committed)"}')
    print('Verified origin/main matches local HEAD:', local)


if __name__ == '__main__':
    try:
        main()
    except (subprocess.CalledProcessError, RuntimeError) as error:
        print(f'Stopped: {error}. Existing work and successful commits are preserved.', file=sys.stderr)
        sys.exit(1)
