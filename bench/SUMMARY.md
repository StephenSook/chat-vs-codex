# Runtime Codex benchmark

Batch `0fb7de68-5526-4ddc-bcf2-d88368d9282a`: **211/212 green (99.5%)**.
Both model configurations pass the GO gate. Timing results remain separate by model.
The approved schedule was three Terra low trials and one Sol high trial per pooled
mutant, across 53 mutants. No failed trial was rerun.

The single loss is an **infrastructure loss**, retained in the denominator:
trial `0128df8e-7cd4-4e5a-9c11-373fa4370ed5`, Terra low, family `other`,
2.53 seconds. Transport error: `stream disconnected before completion: IO error:
received fatal alert: BadRecordMac`. It did not complete the model turn or validation.
Earlier startup and validation experiments are separate batches and excluded here.

Nine green repairs were alternate fixes rather than exact byte reverts. All nine
passed the full visible suite and the held-out route, verified from their validation
logs. Families with alternate fixes:

| Model     | Family           | Alternate green fixes |
| --------- | ---------------- | --------------------: |
| Terra low | enemy-ledge-turn |                     4 |
| Terra low | other            |                     4 |
| Sol high  | other            |                     1 |

These are repeated trials over planted mutants on one machine and level. Bootstrap
intervals describe these trials, not new users or independently sampled bugs. Camera
qualification requires at least ten observations for that model/family and 80% green
within 60 seconds; smaller groups remain insufficient, even when every trial passes.

Recompute the following printout from the committed evidence:

```sh
pnpm bench:summary --batch 0fb7de68-5526-4ddc-bcf2-d88368d9282a
```

```text
Batch: 0fb7de68-5526-4ddc-bcf2-d88368d9282a; source: 18003dafdbc232283bfcd918431f4aa20772c31414df5af5d28153b5aba0810c
Timing: green trials only; p90: nearest rank; bootstrap: 5000 samples, seed 20261030
Chat head start: 15.00 s; round: 60 s; dry runs excluded: 0
gpt-6.1-sol (high)
  Overall: 53/53 green (100.0%); median 29.40 s; p90 35.49 s; median 95% CI [27.49 s, 32.09 s]; exact reverts 52 (98.1% of greens, 98.1% of all); before head start 0; within round 53; camera QUALIFIES; GO
  collision-off-by-one: 3/3 green (100.0%); median 36.52 s; p90 54.72 s; median 95% CI [34.77 s, 54.72 s]; exact reverts 3 (100.0% of greens, 100.0% of all); before head start 0; within round 3; camera INSUFFICIENT SAMPLE; GO
  coyote-never-expires: 1/1 green (100.0%); median 36.45 s; p90 36.45 s; median 95% CI [36.45 s, 36.45 s]; exact reverts 1 (100.0% of greens, 100.0% of all); before head start 0; within round 1; camera INSUFFICIENT SAMPLE; GO
  enemy-ledge-turn: 4/4 green (100.0%); median 30.64 s; p90 32.72 s; median 95% CI [27.15 s, 32.72 s]; exact reverts 4 (100.0% of greens, 100.0% of all); before head start 0; within round 4; camera INSUFFICIENT SAMPLE; GO
  gravity-sign: 3/3 green (100.0%); median 23.90 s; p90 27.49 s; median 95% CI [23.47 s, 27.49 s]; exact reverts 3 (100.0% of greens, 100.0% of all); before head start 0; within round 3; camera INSUFFICIENT SAMPLE; GO
  jump-buffer: 4/4 green (100.0%); median 27.84 s; p90 29.40 s; median 95% CI [26.94 s, 29.40 s]; exact reverts 4 (100.0% of greens, 100.0% of all); before head start 0; within round 4; camera INSUFFICIENT SAMPLE; GO
  other: 35/35 green (100.0%); median 29.81 s; p90 35.47 s; median 95% CI [27.20 s, 33.33 s]; exact reverts 34 (97.1% of greens, 97.1% of all); before head start 0; within round 35; camera QUALIFIES; GO
  swapped-controls: 3/3 green (100.0%); median 31.12 s; p90 33.92 s; median 95% CI [26.06 s, 33.92 s]; exact reverts 3 (100.0% of greens, 100.0% of all); before head start 0; within round 3; camera INSUFFICIENT SAMPLE; GO
gpt-6.1-terra (low)
  Overall: 158/159 green (99.4%); median 14.52 s; p90 18.08 s; median 95% CI [14.15 s, 15.01 s]; exact reverts 150 (94.9% of greens, 94.3% of all); before head start 91; within round 158; camera QUALIFIES; GO
  collision-off-by-one: 9/9 green (100.0%); median 15.04 s; p90 20.72 s; median 95% CI [13.69 s, 17.01 s]; exact reverts 9 (100.0% of greens, 100.0% of all); before head start 4; within round 9; camera INSUFFICIENT SAMPLE; GO
  coyote-never-expires: 3/3 green (100.0%); median 16.23 s; p90 16.27 s; median 95% CI [16.11 s, 16.27 s]; exact reverts 3 (100.0% of greens, 100.0% of all); before head start 0; within round 3; camera INSUFFICIENT SAMPLE; GO
  enemy-ledge-turn: 12/12 green (100.0%); median 13.94 s; p90 17.98 s; median 95% CI [13.05 s, 16.60 s]; exact reverts 8 (66.7% of greens, 66.7% of all); before head start 7; within round 12; camera QUALIFIES; GO
  gravity-sign: 9/9 green (100.0%); median 14.14 s; p90 25.66 s; median 95% CI [12.72 s, 19.66 s]; exact reverts 9 (100.0% of greens, 100.0% of all); before head start 6; within round 9; camera INSUFFICIENT SAMPLE; GO
  jump-buffer: 12/12 green (100.0%); median 15.48 s; p90 17.38 s; median 95% CI [14.37 s, 16.75 s]; exact reverts 12 (100.0% of greens, 100.0% of all); before head start 5; within round 12; camera QUALIFIES; GO
  other: 104/105 green (99.0%); median 14.33 s; p90 18.08 s; median 95% CI [13.81 s, 14.76 s]; exact reverts 100 (96.2% of greens, 95.2% of all); before head start 64; within round 104; camera QUALIFIES; GO
  swapped-controls: 9/9 green (100.0%); median 14.80 s; p90 18.02 s; median 95% CI [14.08 s, 16.82 s]; exact reverts 9 (100.0% of greens, 100.0% of all); before head start 5; within round 9; camera INSUFFICIENT SAMPLE; GO
```
