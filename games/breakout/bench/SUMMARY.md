# Breakout benchmark: n=3, one trial per site

Recomputed with `pnpm breakout:bench --summary` from the retained results.
Model: `gpt-6.1-terra`, low effort. Batch:
`a1ea9419-27f4-4b23-8892-2e8d1d7ddebb`.

| Measure                                 | Observed result and sample                                     |
| --------------------------------------- | -------------------------------------------------------------- |
| Fixed                                   | 3/3, 100.0% (n=3; one trial per site)                          |
| Median time to green                    | 17.07 s (n=3; one trial per site)                              |
| p90 time to green                       | 24.61 s (n=3; one trial per site; nearest rank)                |
| Bootstrap 95% interval for median       | 16.41 to 24.61 s (n=3; one trial per site)                     |
| Exact reverts                           | 3/3, 100.0% of greens and all trials (n=3; one trial per site) |
| Green before configured chat head start | 0/3 (n=3; one trial per site)                                  |
| Green within configured round limit     | 3/3 (n=3; one trial per site)                                  |
| Mechanical timing/fix-rate gate         | GO (n=3; one trial per site)                                   |
| Camera qualification                    | INSUFFICIENT SAMPLE (n=3; one trial per site)                  |

| Site         | Fixed          | Time to green      | Exact revert   |
| ------------ | -------------- | ------------------ | -------------- |
| createState  | 1/1 (n=1 of 3) | 24.61 s (n=1 of 3) | 1/1 (n=1 of 3) |
| paddleBounce | 1/1 (n=1 of 3) | 17.07 s (n=1 of 3) | 1/1 (n=1 of 3) |
| wallBounce   | 1/1 (n=1 of 3) | 16.41 s (n=1 of 3) | 1/1 (n=1 of 3) |

This is a small generalization check, not a reliability estimate. The bootstrap
interval resamples this observed sample (n=3; one trial per site). Per-site
medians, percentiles and intervals each collapse to their single observed time
(n=1 per site within the total n=3).

Configuration, not measured outcomes: chat head start 15 s; round limit 60 s;
bootstrap 5,000 resamples with seed 20261030. Timing includes green trials only.
No scored trial was dropped or rerun. The earlier sandbox preflight refusal is
retained separately and never became a scored trial.

[Results](results.jsonl), [trial events, manifest and preflights](runs/).
