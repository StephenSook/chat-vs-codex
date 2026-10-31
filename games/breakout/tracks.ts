export interface Track {
  name: string;
  seed: number;
  inputs: number[];
}
const frames = (length: number, input: number) =>
  Array<number>(length).fill(input);
export const TRACKS: Track[] = [
  { name: "replay-01", seed: 13, inputs: [...frames(1, 4), ...frames(599, 0)] },
  {
    name: "replay-02",
    seed: 7,
    inputs: [
      ...frames(12, 1),
      ...frames(1, 4),
      ...frames(25, 2),
      ...frames(562, 0),
    ],
  },
  {
    name: "replay-03",
    seed: 42,
    inputs: [
      ...frames(14, 2),
      ...frames(1, 4),
      ...frames(30, 1),
      ...frames(555, 0),
    ],
  },
];
export const HELD_OUT: Track = {
  name: "held-out",
  seed: 71,
  inputs: [
    ...frames(8, 1),
    ...frames(1, 4),
    ...frames(16, 2),
    ...frames(575, 0),
  ],
};
