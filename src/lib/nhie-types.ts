export type Vote = "never" | "done";

export type PlayerView = {
  id: string;
  name: string;
  hearts: number;
  vote: Vote | null;
  isHost: boolean;
  away: boolean;
};

export type TimerPhase = "idle" | "running" | "paused" | "done";

export type RoomView = {
  code: string;
  statement: string;
  roundId: number;
  answered: number;
  previous: string[];
  timer: { phase: TimerPhase; remainingMs: number };
  started: boolean;
  turnId: string | null;
  turnName: string | null;
  you: PlayerView;
  players: PlayerView[];
};

export type SeatResult = { ok: true; room: RoomView } | { ok: false; error: string };

export type LeaveResult = { ok: true } | { ok: false; error: string };
